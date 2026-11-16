// batch 247 B2(ii) (Vincent, 16 Nov) — CODE IS THE ONLY VOICE ON THE SALVAGE CATEGORY.
//
// The model is category-blind by design (Vincent's long-standing ruling: telling it the category made it invent damage to
// justify the category). Fable 5.2 then wrote "the salvage category is not stated in the listing data supplied" on 13 of
// 16 lots, in Red Flags, the confidence line and the exit prose, beside the code's own Salvage History (CAT S), checklist
// slot ("Salvage category recorded") and exit line "(Cat S band)". Opus 4.8 assumed a category instead ("Cat band",
// "confirmed structural-repairable category"). Either way the model is talking about something it was never shown.
//
// This drops every model sentence that states, guesses, defaults or advises on a salvage category. Line-preserving, like
// the claim binder (lib/parts.mjs bindClaimClasses, batch 187): a line with no hit comes back byte-identical.
//   • A sentence whose category mention is ONE ITEM of a list or a trailing "and …" clause loses that item only
//     ("Low — …, the salvage category is not stated in the data supplied, and no photo shows the front structure." →
//     "Low — …, and no photo shows the front structure."). Otherwise the whole sentence goes. If the cut sentence still
//     mentions a category, the whole sentence goes.
//   • A bullet keeps its other sentences (unlike the binder's bullet-orphan rule: KT73YAJ's V5 advice shares a bullet
//     with the category sentence and is true). A bullet left with nothing, or only a label ("**Category:**"), goes.
//   • A field may be emptied: code is the only voice, so nothing is kept to fill it. The page and the PDF already hide
//     an empty field.
//   • Code-owned lines are never read: the exit line ("Exit: £… (Cat S band)"), the auction-notes lines, the Cat A/B
//     stop text (passed in `protect`).
import { sentenceSpans } from './parts.mjs';

const RX_WORD = /\bcategor(?:y|ies|i[sz]ed|i[sz]ation)\b|\buncategori[sz]ed\b/i;
const RX_CAT  = /\bCat(?:egory)?[\s-]?[ABCDNSUX]\b|\bCat[\s-](?:band|marker|status|stigma|rating)\b|\bCAT [ABCDNSUX]\b/;
export const mentionsCategory = (s) => RX_WORD.test(s) || RX_CAT.test(s);

const CODE_LINE_RX = /^(?:Exit: £|Copart's notes say:|The auction notes say:)/;
const LABEL_ONLY_RX = /^[*_\s]*[A-Za-z][A-Za-z /&-]{0,40}:[*_\s]*$/;

// Cut the category item out of a sentence, or return null (drop the whole sentence).
const CUTS = [
  /(?<!,)\s+and\s+(?:the\s+)?salvage\s+category(?=\s+(?:are|were)\b)/i,                        // shared predicate: "X and the salvage category are not established"
  /(?:,\s+|\s+)and\s+(?:(?!\band\b)[^,;.])*?\bcategor[^,;.]*(?=[.;]?\s*$)/i,                       // trailing ", and the category is not stated."
  /,\s+(?:(?!\band\b)[^,;.])*?\bcategor[^,;.]*(?=,)/i,                                          // a middle list item ", the listing data states no category,"
];
export function cutCategoryClause(sentence) {
  for (const [i, rx] of CUTS.entries()) {
    const m = sentence.match(rx);
    if (!m) continue;
    let head = sentence.slice(0, m.index);
    if (!head.trim() || mentionsCategory(head)) continue;
    // shared predicate: the list lost its "and" — put it back before the last remaining item ("A, B, and C are …")
    if (i === 0 && head.includes(', ') && !/\band\b[^,]*$/.test(head)) head = head.replace(/, (?!.*, )/, ', and ');
    const out = (head + sentence.slice(m.index + m[0].length)).replace(/\s+([.;,])/g, '$1');
    if (!mentionsCategory(out) && /[A-Za-z]/.test(out)) return out;
  }
  return null;
}

/**
 * @param text     a model-authored field
 * @param protect  exact code-owned strings that must never be touched (e.g. the Cat A/B stop text)
 * @returns {{ text: string, dropped: { sentence: string, keptAs: string|null }[] }}
 */
export function dropCategorySentences(text, { protect = [] } = {}) {
  const dropped = [];
  if (!text || typeof text !== 'string' || !mentionsCategory(text)) return { text: text || '', dropped };
  const isProtected = (body) => CODE_LINE_RX.test(body.trim()) || protect.some((p) => p && body.includes(p));
  const keptLines = [];
  let edited = false;
  for (const line of text.split('\n')) {
    if (!line.trim() || !mentionsCategory(line)) { keptLines.push(line); continue; }
    const bulletM = line.match(/^(\s*(?:[-*•]|\d+[.)])?\s*)([\s\S]*)$/);
    const prefix = bulletM ? bulletM[1] : '';
    const body = bulletM ? bulletM[2] : line;
    if (isProtected(body)) { keptLines.push(line); continue; }
    const spans = sentenceSpans(body);
    let hit = false;
    for (const sp of spans) {
      if (!mentionsCategory(sp.text)) continue;
      hit = true;
      sp.repl = cutCategoryClause(sp.text);   // null → drop the sentence
      dropped.push({ sentence: sp.text, keptAs: sp.repl });
    }
    if (!hit) { keptLines.push(line); continue; }
    edited = true;
    // Rebuild from the original gaps, exactly as the binder does.
    let b = '';
    let first = true;
    spans.forEach((sp, i) => {
      const t = sp.repl === undefined ? sp.text : sp.repl;
      if (t === null) return;
      if (first) b += body.slice(0, spans[0].start); else b += body.slice(spans[i - 1].end, sp.start);
      b += t;
      first = false;
    });
    if (!first) b += body.slice(spans[spans.length - 1].end);
    const rest = b.trim();
    keptLines.push(!rest || LABEL_ONLY_RX.test(rest) ? null : prefix + b.replace(/^\s+/, ''));
  }
  if (!edited) return { text, dropped };
  const lines = [];
  for (let i = 0; i < keptLines.length; i++) {
    const l = keptLines[i];
    if (l !== null) { lines.push(l); continue; }
    const prevBlank = lines.length && !lines[lines.length - 1].trim();
    const nextBlank = keptLines[i + 1] != null && !keptLines[i + 1].trim();
    if (prevBlank && nextBlank) i++;
  }
  let out = lines.join('\n');
  if (text === text.trim()) out = out.trim();
  return { text: out, dropped };
}
