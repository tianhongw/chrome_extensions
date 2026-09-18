/** Request sent by a client (content script) over a `translate` port. */
export interface TranslateRequest {
  type: "translate";
  text: string;
}

/**
 * Events streamed back over the port. `partial` carries the machine
 * translation accumulated so far; exactly one `done` or `error` ends the
 * exchange.
 */
export type TranslateEvent =
  | { type: "partial"; tgt: string }
  | { type: "done"; data: TranslationResult }
  | { type: "error"; error: string };

/** Plain machine-translation result (used for sentences / long text). */
export interface PlainResult {
  kind: "plain";
  src: string;
  tgt: string;
  /** e.g. "en2zh-CHS" — the detected direction. */
  type: string;
}

export interface DictPhonetic {
  /** "英" or "美" */
  region: string;
  /** IPA without slashes, e.g. "skrætʃ" */
  ph: string;
}

export interface DictDef {
  /** part of speech, e.g. "v." / "n." — may be empty. */
  pos: string;
  /** the gloss text. */
  def: string;
}

export interface DictForm {
  /** e.g. "复数" */
  name: string;
  value: string;
}

export interface DictPhrase {
  phrase: string;
  trans: string;
}

/** Rich dictionary entry (used for single words / short lookups). */
export interface DictResult {
  kind: "dict";
  word: string;
  /** short headline gloss, e.g. "划痕". */
  brief: string;
  phonetics: DictPhonetic[];
  /** exam tags, e.g. ["高中","CET4",...]. */
  examTags: string[];
  defs: DictDef[];
  forms: DictForm[];
  phrases: DictPhrase[];
}

export type TranslationResult = PlainResult | DictResult;

export type TranslateResponse =
  | { ok: true; data: TranslationResult }
  | { ok: false; error: string };

/** Payload the background stores under `storage.session.lastResult` for the result window. */
export type ResultPayload =
  | { loading: true; query: string; partial?: string }
  | { data: TranslationResult }
  | { error: string };
