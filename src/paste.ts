/** Shared policy for clipboard, native paste, and future snippet entry points. */
export function needsPastePreview(text: string): boolean {
  // Include terminal control characters even without a newline.
  return /[\x00-\x08\x0a-\x1f\x7f-\x9f\u2028\u2029]/.test(text);
}

export function pasteLineCount(text: string): number {
  return text.split(/\r\n|[\r\n\u2028\u2029]/).length;
}

export function pastePreview(text: string): string {
  // Keep LF layout but make all other control bytes visible, including CR and ESC.
  return text.replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f\u2028\u2029]/g, (c) =>
    `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}
