import { md5Hex } from "./md5";
import type {
  DictDef,
  DictForm,
  DictPhonetic,
  DictPhrase,
  DictResult,
  PlainResult,
  TranslationResult,
} from "./messages";
import { sessionGet, sessionRemove, sessionSet } from "./session-store";

// Reverse-engineered from the live fanyi.youdao.com web app (translation-website
// bundle). The current site uses an LLM-backed, signed, SSE-streamed flow:
//   1. POST /translate/key  -> { token, secretKey }   (signed with KEY_GETTER_SECRET)
//   2. POST /webtranslate/sse (multipart, signed with the fresh secretKey)
//      -> text/event-stream of {"transIncre": "..."} chunks
// The older dict.youdao.com/webtranslate endpoint now returns honeypot/fake
// results, so it is intentionally NOT used.
const BASE = "https://dict-trans.youdao.com";

// Constants from the web bundle — update here if Youdao rotates them (symptom:
// key-getter returns a non-zero code, or translations stop working).
const KEY_GETTER_SECRET = "kSy5gtKA4yRUxAVPJPrdYKZ0jBKyd3t1";
const KEY_GETTER_KEYID = "translate-webmain-key-getter";
const TARGET_KEYID = "translate-webfanyi-webmain";

type Params = Record<string, string | number>;

/**
 * Youdao's `genSign`: drop empty values, sort keys, append `key=<secret>`,
 * md5 the `k=v&k=v...` string. Returns [sign, pointParam].
 */
function genSign(params: Params, secret: string): [string, string] {
  const o: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) {
    if (v === "" || v === undefined || v === null) continue;
    o[k] = String(v);
  }
  const keys = Object.keys(o).sort();
  keys.push("key");
  o["key"] = secret;
  const signStr = keys.map((k) => `${k}=${o[k]}`).join("&");
  return [md5Hex(signStr), keys.join(",")];
}

function stringifyParams(params: Params): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) out[k] = String(v);
  return out;
}

// --- Signing key -----------------------------------------------------------
// The key from /translate/key stays valid across many requests (the web app
// itself fetches it once per session), so we cache it: in memory, and in
// session storage so a recycled service worker doesn't pay the extra ~300ms
// round trip again. If the server rejects a signature we drop the key, fetch a
// fresh one and retry once.
interface SignKey {
  token: string;
  secretKey: string;
}

const KEY_STORAGE = "youdaoSignKey";
let keyMem: SignKey | null = null;
let keyInflight: Promise<SignKey> | null = null;

async function requestKey(): Promise<SignKey> {
  const params: Params = {
    keyid: KEY_GETTER_KEYID,
    targetKeyid: TARGET_KEYID,
    product: "webfanyi",
    appVersion: "12.0.0",
    client: "webmain",
    mid: 1,
    vendor: "web",
    screen: 1,
    model: 1,
    imei: 1,
    network: "wifi",
    keyfrom: "webfanyi.webmain",
    mysticTime: Date.now(),
    yduuid: "abcdefg",
    abtest: 0,
  };
  const [sign, pointParam] = genSign(params, KEY_GETTER_SECRET);
  const body = new URLSearchParams({ ...stringifyParams(params), sign, pointParam });

  const resp = await fetch(`${BASE}/translate/key`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!resp.ok) throw new Error(`获取密钥失败 (HTTP ${resp.status})`);
  const json = (await resp.json()) as { code: number; data?: SignKey };
  if (json.code !== 0 || !json.data?.token || !json.data?.secretKey) {
    throw new Error(`获取密钥失败 (code ${json.code})`);
  }
  return { token: json.data.token, secretKey: json.data.secretKey };
}

async function getKey(forceRefresh = false): Promise<SignKey> {
  if (forceRefresh) {
    keyMem = null;
    await sessionRemove(KEY_STORAGE);
  } else {
    if (keyMem) return keyMem;
    const stored = await sessionGet<SignKey>(KEY_STORAGE);
    if (stored?.token && stored?.secretKey) return (keyMem = stored);
  }
  // Coalesce concurrent fetches into one request.
  if (!keyInflight) {
    keyInflight = requestKey()
      .then((k) => {
        keyMem = k;
        void sessionSet(KEY_STORAGE, k);
        return k;
      })
      .finally(() => {
        keyInflight = null;
      });
  }
  return keyInflight;
}

// Youdao expects an explicit from/to. Detect direction by the presence of CJK
// characters: Chinese -> English, otherwise -> Chinese.
function detectDirection(text: string): { from: string; to: string } {
  const hasChinese = /[一-鿿]/.test(text);
  return hasChinese ? { from: "zh-CHS", to: "en" } : { from: "en", to: "zh-CHS" };
}

// --- SSE ------------------------------------------------------------------
class SignatureRejected extends Error {}

interface SseChunk {
  transIncre?: string;
  type?: string;
  code?: number;
  msg?: string;
}

/**
 * Incrementally read the event stream, calling `onChunk` for each parsed
 * `data:` JSON line as it arrives (rather than waiting for the whole body).
 */
async function readSse(resp: Response, onChunk: (c: SseChunk) => void): Promise<void> {
  const handleLine = (line: string): void => {
    const s = line.trim();
    if (!s.startsWith("data:")) return;
    const payload = s.slice(5).trim();
    if (!payload.startsWith("{")) return;
    try {
      onChunk(JSON.parse(payload) as SseChunk);
    } catch {
      /* ignore non-JSON data lines */
    }
  };

  const reader = resp.body?.getReader();
  if (!reader) {
    for (const line of (await resp.text()).split("\n")) handleLine(line);
    return;
  }
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      handleLine(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
    }
  }
  buf += decoder.decode();
  if (buf) handleLine(buf);
}

async function translateSseOnce(
  text: string,
  key: SignKey,
  onPartial?: (tgt: string) => void,
): Promise<PlainResult> {
  const { from, to } = detectDirection(text);

  const params: Params = {
    i: text,
    from,
    to,
    useTerm: "false",
    modelName: "llmLite",
    product: "webfanyi",
    appVersion: "1",
    client: "webmain",
    mid: 1,
    vendor: "web",
    screen: 1,
    model: 1,
    imei: 1,
    network: "wifi",
    keyfrom: "webfanyi.webmain",
    keyid: TARGET_KEYID,
    keyId: TARGET_KEYID,
    mysticTime: Date.now(),
    yduuid: "abcdefg",
    signSecretKey: key.secretKey,
    token: key.token,
    source: "webmain",
  };
  const [sign, pointParam] = genSign(params, key.secretKey);

  // multipart/form-data — the browser sets the boundary automatically.
  const form = new FormData();
  for (const [k, v] of Object.entries(params)) form.append(k, String(v));
  form.append("sign", sign);
  form.append("pointParam", pointParam);

  const resp = await fetch(`${BASE}/webtranslate/sse`, { method: "POST", body: form });
  if (!resp.ok) throw new Error(`请求失败 (HTTP ${resp.status})`);

  // A rejected signature comes back as `application/json` {"code":403,...}
  // instead of an event stream.
  const contentType = resp.headers.get("content-type") ?? "";
  if (!contentType.includes("text/event-stream")) {
    let code: number | undefined;
    let msg = "";
    try {
      const j = (await resp.json()) as SseChunk;
      code = j.code;
      msg = j.msg ?? "";
    } catch {
      /* not JSON either */
    }
    if (code === 403) throw new SignatureRejected(msg || "签名验证失败");
    throw new Error(msg ? `翻译失败：${msg}` : `翻译失败 (code ${code ?? "?"})`);
  }

  let tgt = "";
  let type = "";
  await readSse(resp, (j) => {
    if (typeof j.transIncre === "string" && j.transIncre) {
      tgt += j.transIncre;
      onPartial?.(tgt);
    }
    if (!type && typeof j.type === "string") type = j.type;
  });

  if (!tgt) throw new Error("未获取到翻译结果");
  return { kind: "plain", src: text, tgt, type: type || `${from}2${to}` };
}

/**
 * Translate `text` via the free Youdao web flow. Direction is auto-detected
 * (Chinese <-> English). `onPartial` receives the accumulated translation as
 * chunks stream in. Throws on network errors or empty results.
 */
async function translateSse(text: string, onPartial?: (tgt: string) => void): Promise<PlainResult> {
  try {
    return await translateSseOnce(text, await getKey(), onPartial);
  } catch (e) {
    if (!(e instanceof SignatureRejected)) throw e;
    // Stale/rotated key: refresh and retry exactly once.
    return translateSseOnce(text, await getKey(true), onPartial);
  }
}

// --- Dictionary (jsonapi) -------------------------------------------------
// dict.youdao.com/jsonapi returns rich entries: phonetics, exam tags, defs by
// part-of-speech, word forms, and phrases. Used for single words / short
// lookups; sentences fall back to the SSE machine translation above.
const DICT_BASE = "https://dict.youdao.com";

/** Recursively flatten Youdao's `l.i` value (string | array of string|node). */
function flattenI(i: unknown): string {
  if (typeof i === "string") return i;
  if (Array.isArray(i)) return i.map(flattenI).join("");
  if (i && typeof i === "object" && typeof (i as any)["#text"] === "string") {
    return (i as any)["#text"];
  }
  return "";
}

function textOfL(l: any): string {
  return flattenI(l?.i).trim();
}

// Split a leading part-of-speech marker ("v.", "n.", "adj.", "abbr.") off a def.
function splitPos(line: string): DictDef {
  const m = line.match(/^([a-z]+\.)\s*(.*)$/s);
  if (m) return { pos: m[1], def: m[2].trim() };
  return { pos: "", def: line.trim() };
}

interface JsonApi {
  ec?: {
    exam_type?: string[];
    word?: Array<{
      usphone?: string;
      ukphone?: string;
      trs?: Array<{ tr?: Array<{ l?: any }> }>;
      wfs?: Array<{ wf?: { name?: string; value?: string } }>;
    }>;
  };
  ce?: {
    word?: Array<{ trs?: Array<{ tr?: Array<{ l?: any }> }> }>;
  };
  phrs?: {
    phrs?: Array<{
      phr?: { headword?: { l?: any }; trs?: Array<{ tr?: { l?: any } }> };
    }>;
  };
}

function parsePhrases(json: JsonApi): DictPhrase[] {
  const out: DictPhrase[] = [];
  for (const item of json.phrs?.phrs ?? []) {
    const phrase = textOfL(item.phr?.headword?.l);
    const trans = textOfL(item.phr?.trs?.[0]?.tr?.l);
    if (phrase && trans) out.push({ phrase, trans });
  }
  return out;
}

function parseEnglish(json: JsonApi): DictResult | null {
  const w = json.ec?.word?.[0];
  if (!w?.trs?.length) return null;

  const phonetics: DictPhonetic[] = [];
  if (w.usphone) phonetics.push({ region: "美", ph: w.usphone });
  if (w.ukphone) phonetics.push({ region: "英", ph: w.ukphone });

  const defs: DictDef[] = [];
  for (const trsItem of w.trs) {
    const line = textOfL(trsItem.tr?.[0]?.l);
    if (line) defs.push(splitPos(line));
  }

  const forms: DictForm[] = [];
  for (const item of w.wfs ?? []) {
    if (item.wf?.name && item.wf?.value) {
      forms.push({ name: item.wf.name, value: item.wf.value });
    }
  }

  return {
    kind: "dict",
    word: "",
    brief: "",
    phonetics,
    examTags: json.ec?.exam_type ?? [],
    defs,
    forms,
    phrases: parsePhrases(json),
  };
}

function parseChinese(json: JsonApi): DictResult | null {
  const w = json.ce?.word?.[0];
  if (!w?.trs?.length) return null;

  const defs: DictDef[] = [];
  for (const trsItem of w.trs) {
    const line = textOfL(trsItem.tr?.[0]?.l);
    if (line) defs.push({ pos: "", def: line });
  }
  if (!defs.length) return null;

  return {
    kind: "dict",
    word: "",
    brief: "",
    phonetics: [],
    examTags: [],
    defs,
    forms: [],
    phrases: parsePhrases(json),
  };
}

async function dictLookup(text: string): Promise<DictResult | null> {
  const dicts = encodeURIComponent(
    JSON.stringify({ count: 99, dicts: [["ec", "ce", "simple", "phrs"]] }),
  );
  const url = `${DICT_BASE}/jsonapi?q=${encodeURIComponent(text)}&dicts=${dicts}`;
  const resp = await fetch(url);
  if (!resp.ok) return null;
  const json = (await resp.json()) as JsonApi;
  const entry = parseEnglish(json) ?? parseChinese(json);
  if (entry) entry.word = text;
  return entry;
}

// The LLM sometimes just echoes a single word back ("scratch" -> "Scratch").
// In that case the first sense of the first dictionary gloss makes a far
// better headline than the echoed word.
const BRIEF_MAX = 30;
function pickBrief(word: string, mt: string | undefined, defs: DictDef[]): string {
  const echoed = !mt || mt.trim().toLowerCase() === word.trim().toLowerCase();
  if (!echoed) return mt!.trim();
  const firstSense = (defs[0]?.def ?? "").split(/[;；]/)[0].trim();
  return firstSense.length > BRIEF_MAX ? `${firstSense.slice(0, BRIEF_MAX)}…` : firstSense;
}

/**
 * Translate `text`. Short inputs (single word / short phrase) are looked up in
 * the dictionary for a rich result; everything else uses machine translation,
 * streaming partial output through `onPartial` when provided.
 */
export async function translate(
  text: string,
  onPartial?: (tgt: string) => void,
): Promise<TranslationResult> {
  const trimmed = text.trim();
  const eligible =
    !/\n/.test(trimmed) &&
    trimmed.length <= 40 &&
    trimmed.split(/\s+/).filter(Boolean).length <= 4;

  if (!eligible) return translateSse(trimmed, onPartial);

  // Short lookups are fast and the dictionary card replaces the plain text
  // anyway, so don't stream partials here (it would just flash).
  const [plain, dict] = await Promise.all([
    translateSse(trimmed).catch(() => null),
    dictLookup(trimmed).catch(() => null),
  ]);

  if (dict) {
    dict.brief = pickBrief(trimmed, plain?.tgt, dict.defs);
    return dict;
  }
  if (plain) return plain;
  throw new Error("未获取到翻译结果");
}
