import { categories, type Category, type OutlineItem, type TranscriptMessage } from './types';

/** Evidence is checked against the current message, never an earlier revision. */
export function hasValidEvidence(item: OutlineItem, messages: readonly TranscriptMessage[]): boolean {
  const evidence = item.evidence;
  const source = messages.find(message => message.id === evidence.messageId);
  return Boolean(source && categories.includes(item.category)
    && typeof item.title === 'string' && item.title.trim().length > 0
    && typeof evidence.quote === 'string' && evidence.quote.trim().length > 0
    && Number.isInteger(evidence.start) && Number.isInteger(evidence.end)
    && evidence.start >= 0 && evidence.end > evidence.start
    && evidence.end <= source.text.length
    && source.text.slice(evidence.start, evidence.end) === evidence.quote
    && evidence.quote.includes(item.title));
}

function classify(text: string, role: TranscriptMessage['role']): Category | null {
  // Explicit examples and draft copy describe another utterance, not a claim
  // or an open question in this conversation.
  if (/^(?:>\s*|["“]|(?:draft(?: [^:\n]{1,60})?|example|sample|quote)\s*:)/i.test(text)) return null;
  if (/^(?:correction\b|actually[, :]|i was wrong\b|on second thought\b|let me (?:correct|revise)\b)/i.test(text)) return 'correction';
  if (role === 'user' && /^to (?:be clear|clarify)\s*:/i.test(text)) return 'correction';
  if (!text.endsWith('?') && !/^(?:if|unless|suppose|imagine|for example)\b/i.test(text) && (/^decision\s*:/i.test(text) || /\b(?:we (?:have )?decided|i (?:have )?decided|we(?:'|’)ll (?:use|go with)|let(?:'|’)s use|we(?:'|’)re going (?:with|to use))\b/i.test(text))) return 'decision';
  if (/^(?:[-*]\s*)?(?:\[[ xX]\]\s*|todo\b|action\s*:|next steps?\s*:|we (?:should|need to)\b|let(?:'|’)s (?!use\b))/i.test(text)) return 'action';
  if (text.endsWith('?') && /[a-z]/i.test(text) && (role === 'user' ||
    (role === 'assistant' && /^(?:one (?:(?:quick|more|last(?: important)?) )?(?:question|clarification)(?: that would help)?\s*:|can you clarify\b|could you\b|do you\b|are you\b)/i.test(text)))) return 'question';
  // Preserve recommendation wording rather than implying a user commitment.
  if (role === 'assistant' && /(?:^|[,;:]\s*)i would (?:(?:also|still) )?(?:recommend|suggest|pursue|compare|check|confirm|verify|ask|get|start|prioritize|consider|try|test)\b/i.test(text)) return 'action';
  if (/^(?:[-*]\s*)?(?:confirm|ask|compare|verify|check|request|review|test)\b/i.test(text) || /^(?:[-*]\s*)?get\s+\S/i.test(text)) return 'action';
  if (/\b[\w-]+\.(?:md|pdf|docx|xlsx|csv|ts|tsx|js|py|swift|json|html|zip|log|txt)\b/i.test(text)
    && /\b(?:created|saved|attached|generated|wrote|file|artifact)\b/i.test(text)) return 'artifact';
  if (role === 'user' && /^(?:remember|constraint|requirement|note)\s*:/i.test(text)) return 'note';
  if (/^note\s*:\s*\S/i.test(text)) return 'note';
  return null;
}

interface Span { start: number; end: number; category?: Category }

function spans(text: string): Span[] {
  const result: Span[] = [];
  const fences = [...text.matchAll(/^```[^\n]*\n[\s\S]*?^```[^\S\n]*(?=\n|$)/gm)];
  let cursor = 0;
  const prose = (start: number, end: number) => {
    const portion = text.slice(start, end);
    // Split on sentence endings only when followed by whitespace, preserving offsets.
    for (const match of portion.matchAll(/[^\n]+/g)) {
      const lineStart = start + match.index;
      let sentenceStart = 0;
      const ends = [...match[0].matchAll(/[.!?]+(?=\s|$)/g)].map(end => end.index + end[0].length);
      if (ends.at(-1) !== match[0].length) ends.push(match[0].length);
      for (const sentenceEnd of ends) {
        const raw = match[0].slice(sentenceStart, sentenceEnd);
        const leading = raw.length - raw.trimStart().length;
        const value = raw.trim();
        if (value) result.push({ start: lineStart + sentenceStart + leading, end: lineStart + sentenceStart + leading + value.length });
        sentenceStart = sentenceEnd;
      }
    }
  };
  for (const fence of fences) {
    prose(cursor, fence.index);
    result.push({ start: fence.index, end: fence.index + fence[0].length, category: 'code' });
    cursor = fence.index + fence[0].length;
  }
  prose(cursor, text.length);
  return result;
}

export function extractOutline(messages: readonly TranscriptMessage[]): { items: OutlineItem[]; droppedCandidates: number } {
  const candidates: OutlineItem[] = [];
  const seen = new Set<string>();
  for (const message of messages) {
    if (message.role === 'system' || message.role === 'tool') continue;
    for (const span of spans(message.text)) {
      const quote = message.text.slice(span.start, span.end);
      const category = span.category ?? classify(quote, message.role);
      if (!category) continue;
      const key = `${category}:${quote.toLocaleLowerCase().replace(/\s+/g, ' ')}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const codeContent = category === 'code' ? quote.split('\n').slice(1, -1).find(line => line.trim())?.trim() : undefined;
      const title = (codeContent ?? quote).slice(0, 100).trimEnd();
      candidates.push({
        id: `${encodeURIComponent(message.id)}:${span.start}:${category}`,
        category,
        title,
        evidence: { messageId: message.id, quote, start: span.start, end: span.end },
      });
    }
  }
  const items = candidates.filter(candidate => hasValidEvidence(candidate, messages));
  return { items, droppedCandidates: candidates.length - items.length };
}
