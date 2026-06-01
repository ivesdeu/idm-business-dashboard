// Humanize Supabase GoTrue password-complexity error messages.
//
// GoTrue returns errors like:
//   "Password should be at least 6 characters. Password should contain at
//    least one character of each: abcdefghijklmnopqrstuvwxyz,
//    ABCDEFGHIJKLMNOPQRSTUVWXYZ, 0123456789."
//
// That's accurate but unreadable. This helper rewrites the verbose character
// lists into named groups (e.g. "lowercase letters") so it can be shown to
// users without scaring them. Non-password errors pass through unchanged.

const LOWERCASE = 'abcdefghijklmnopqrstuvwxyz';
const UPPERCASE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const DIGITS = '0123456789';
// GoTrue's default symbol set when "symbols" is required.
const SYMBOLS = "!@#$%^&*()_+-=[]{};'\\:\"|<>?,./`~";

function replaceCharset(input: string, charset: string, label: string): string {
  if (!input.includes(charset)) return input;
  return input.split(charset).join(label);
}

export function humanizePasswordError(message: string | null | undefined): string {
  if (!message) return '';
  let out = String(message);

  out = replaceCharset(out, LOWERCASE, 'lowercase letters');
  out = replaceCharset(out, UPPERCASE, 'uppercase letters');
  out = replaceCharset(out, DIGITS, 'numbers');
  out = replaceCharset(out, SYMBOLS, 'symbols');

  out = out
    .replace(/Password should contain at least one character of each:\s*/i, 'Password must include ')
    .replace(/Password should be at least (\d+) characters?\.?/i, 'Password must be at least $1 characters long.')
    .replace(/\s+/g, ' ')
    .trim();

  return out;
}
