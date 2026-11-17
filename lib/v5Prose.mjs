// batch 247 B3 ruling 1 (Vincent, 17 Nov) — CODE IS THE ONLY VOICE ON THE V5.
//
// The code-owned marker line (lib/categoryMarker.mjs) says whether the V5 is there and what the buyer must do. The model
// wrote its own "no V5, apply to DVLA" sentence on 10 of the 11 no-V5 lots, so the buyer read it twice. This drops every
// model sentence about whether a V5 / V5C / logbook / registration document is present, absent, or must be applied for.
// Same engine and rules as the category filter (lib/categoryProse.mjs dropSentencesBy): a line with no hit comes back
// byte-identical; a clause is cut from a list where that keeps the rest true; a bullet keeps its other sentences
// (EA17HDN keeps its MOT sentence); a bullet left with only a label ("- V5:") goes; a sentence that only points back at a
// dropped one goes with it; code lines (notes lines, exit line, anything in `protect`) are never read. The marker line is
// added after this filter runs, so it is never read either.
import { dropSentencesBy } from './categoryProse.mjs';

const RX_DOC      = /\bV5C?\b|\blog ?book\b|\bregistration (?:document|certificate)\b/i;
const RX_STATE    = /\b(?:present|absent|missing|supplied|available|included|comes?|with(?:out)?|no|not|none|apply|applied|application|replacement|reissued?|new keeper|re-?regist\w*)\b/i;
const RX_DVLA_APP = /\bDVLA\b.*\b(?:apply|applied|application|replacement)\b|\b(?:apply|applied|application|replacement)\b.*\bDVLA\b/i;

/** True when a sentence is about whether the V5 is there or must be applied for. */
export const mentionsV5 = (s) => (RX_DOC.test(s) && RX_STATE.test(s)) || RX_DVLA_APP.test(s);

// Cut the V5 clause out of a sentence, or return null (drop the whole sentence).
const DOC = String.raw`(?:V5C?|log ?book|registration (?:document|certificate))`;
const CUTS = [
  { rx: new RegExp(String.raw`\s+with(?:out)?\s+(?:a\s+|an\s+|no\s+|the\s+)?${DOC}(?:\s+(?:present|supplied|included|available))?(?=[,;.]?(?:\s|$))`, 'i') },   // "a non-insurer entry with no V5 present."
  { rx: new RegExp(String.raw`(?<!,)\s+and\s+(?:the\s+|a\s+|no\s+)?(?:[a-z-]+\s+){0,2}${DOC}(?=,)`, 'i'), relist: true },                                      // last list item before a clause: "A, B and the missing V5, which …"
  { rx: new RegExp(String.raw`(?:,\s+|\s+)and\s+(?:(?!\band\b)[^,;.])*?\b${DOC}\b[^,;.]*(?=[.;]?\s*$)`, 'i'), relist: true },                                    // trailing ", and no V5 is supplied."
  { rx: new RegExp(String.raw`,\s+(?:(?!\band\b)[^,;.])*?\b${DOC}\b[^,;.]*(?=,)`, 'i') },                                                                         // a middle list item ", the V5 is missing,"
];
const CONNECTIVE_ONLY_RX = /^\s*(?:however|but|and|so|also|yet|still|equally|further(?:more)?|in addition|moreover)\s*,?\s*$/i;
export function cutV5Clause(sentence) {
  for (const { rx, relist } of CUTS) {
    const m = sentence.match(rx);
    if (!m) continue;
    let head = sentence.slice(0, m.index);
    if (!head.trim() || mentionsV5(head) || CONNECTIVE_ONLY_RX.test(head)) continue;   // never leave "However, which …"
    // the list lost its last "and" item — put the "and" back before the last remaining item ("A, B and C" → "A and B")
    if (relist && head.includes(', ') && !/\band\b[^,]*$/.test(head)) head = head.replace(/, (?!.*, )/, ' and ');
    const out = (head + sentence.slice(m.index + m[0].length)).replace(/\s+([.;,])/g, '$1');
    if (!mentionsV5(out) && /[A-Za-z]/.test(out)) return out;
  }
  return null;
}

/**
 * @param text     a model-authored field
 * @param protect  exact code-owned strings that must never be touched
 * @returns {{ text: string, dropped: { sentence: string, keptAs: string|null, orphan?: true }[] }}
 */
export function dropV5Sentences(text, { protect = [] } = {}) {
  return dropSentencesBy(text, { mentions: mentionsV5, cut: cutV5Clause, protect });
}
