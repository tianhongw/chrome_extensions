import type { DictResult, TranslationResult } from "./messages";

export function el(cls: string, text?: string): HTMLDivElement {
  const d = document.createElement("div");
  d.className = cls;
  if (text !== undefined) d.textContent = text;
  return d;
}

export function makeCopyButton(getText: () => string): HTMLButtonElement {
  const copy = document.createElement("button");
  copy.className = "yd-bubble__copy";
  copy.textContent = "复制";
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(getText());
      copy.textContent = "已复制";
      setTimeout(() => (copy.textContent = "复制"), 1200);
    } catch {
      /* clipboard may be blocked; ignore */
    }
  });
  return copy;
}

function renderDict(bubble: HTMLElement, d: DictResult): void {
  bubble.innerHTML = "";
  bubble.classList.add("yd-bubble--dict");

  bubble.appendChild(el("yd-word", d.word));
  if (d.brief) bubble.appendChild(el("yd-brief", d.brief));

  if (d.phonetics.length) {
    const row = el("yd-phonetics");
    for (const p of d.phonetics) {
      const item = el("yd-phonetic");
      item.appendChild(el("yd-phonetic__region", p.region));
      item.appendChild(el("yd-phonetic__ph", `/${p.ph}/`));
      row.appendChild(item);
    }
    bubble.appendChild(row);
  }

  if (d.examTags.length) {
    const tags = el("yd-tags");
    for (const t of d.examTags) tags.appendChild(el("yd-tag", t));
    bubble.appendChild(tags);
  }

  if (d.defs.length) {
    const defs = el("yd-defs");
    for (const def of d.defs) {
      const row = el("yd-def");
      if (def.pos) row.appendChild(el("yd-def__pos", def.pos));
      row.appendChild(el("yd-def__text", def.def));
      defs.appendChild(row);
    }
    bubble.appendChild(defs);
  }

  if (d.forms.length) {
    const forms = el("yd-forms");
    for (const f of d.forms) {
      const row = el("yd-form");
      row.appendChild(el("yd-form__name", `${f.name}:`));
      row.appendChild(el("yd-form__value", f.value));
      forms.appendChild(row);
    }
    bubble.appendChild(forms);
  }

  if (d.phrases.length) {
    const phrases = el("yd-phrases");
    for (const p of d.phrases) {
      const row = el("yd-phrase");
      row.appendChild(el("yd-phrase__head", p.phrase));
      row.appendChild(el("yd-phrase__trans", p.trans));
      phrases.appendChild(row);
    }
    bubble.appendChild(phrases);
  }

  const footer = el("yd-bubble__footer");
  footer.appendChild(el("yd-bubble__type", "有道词典"));
  footer.appendChild(makeCopyButton(() => d.brief || d.defs.map((x) => x.def).join("\n")));
  bubble.appendChild(footer);
}

function renderPlain(bubble: HTMLElement, data: { tgt: string; type: string }): void {
  bubble.innerHTML = "";
  bubble.appendChild(el("yd-bubble__result", data.tgt));

  const footer = el("yd-bubble__footer");
  footer.appendChild(el("yd-bubble__type", data.type));
  footer.appendChild(makeCopyButton(() => data.tgt));
  bubble.appendChild(footer);
}

export function renderResult(bubble: HTMLElement, data: TranslationResult): void {
  bubble.className = "yd-bubble";
  if (data.kind === "dict") renderDict(bubble, data);
  else renderPlain(bubble, data);
}

/**
 * Render machine-translation output that is still streaming in. Reuses the
 * existing text node between calls so the bubble doesn't flicker.
 */
export function showPartial(bubble: HTMLElement, tgt: string): void {
  let out = bubble.querySelector<HTMLElement>(".yd-bubble__result");
  if (!out || !bubble.classList.contains("yd-bubble--streaming")) {
    bubble.className = "yd-bubble yd-bubble--streaming";
    bubble.innerHTML = "";
    out = el("yd-bubble__result");
    bubble.appendChild(out);
  }
  out.textContent = tgt;
}

export function showLoading(bubble: HTMLElement, text = "翻译中…"): void {
  bubble.className = "yd-bubble";
  bubble.innerHTML = "";
  bubble.appendChild(el("yd-bubble__loading", text));
}

export function showError(bubble: HTMLElement, message: string): void {
  bubble.className = "yd-bubble";
  bubble.innerHTML = "";
  bubble.appendChild(el("yd-bubble__error", message));
}
