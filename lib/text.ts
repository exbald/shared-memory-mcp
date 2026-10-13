/** s.slice(0, max) that never leaves half of a surrogate pair (an emoji, say) at the end. */
export function sliceSafe(s: string, max: number): string {
  if (s.length <= max) return s;
  const code = s.charCodeAt(max - 1);
  return s.slice(0, code >= 0xd800 && code <= 0xdbff ? max - 1 : max);
}
