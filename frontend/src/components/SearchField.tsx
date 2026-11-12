import { useEffect, useRef, useState } from 'react';

/** How long a search box waits after the last keystroke before it searches. */
export const SEARCH_DEBOUNCE_MS = 300;

export interface SearchFieldProps {
  label: string;
  /** The search the URL holds now. */
  value: string | undefined;
  maxLength: number;
  className?: string | undefined;
  /** Called a moment after typing stops, with the trimmed text or undefined when blank. */
  onSearch: (q: string | undefined) => void;
}

/**
 * The one search box (ADR-0018): searches a moment after typing stops, and follows the URL
 * when it changes another way (Back, Forward), without disturbing the text being typed.
 */
export function SearchField({ label, value, maxLength, className, onSearch }: SearchFieldProps) {
  const [text, setText] = useState(value ?? '');
  // The last value this box put in the URL, so its own update doesn't reset the text.
  const sent = useRef(value);
  useEffect(() => {
    if (value !== sent.current) {
      sent.current = value;
      setText(value ?? '');
    }
  }, [value]);

  const search = useRef(onSearch);
  useEffect(() => {
    search.current = onSearch;
  });
  useEffect(() => {
    const q = text.trim() || undefined;
    if (q === sent.current) return;
    const timer = setTimeout(() => {
      sent.current = q;
      search.current(q);
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [text]);

  return (
    <label className={className}>
      {label}
      <input
        type="search"
        value={text}
        maxLength={maxLength}
        onChange={(event) => {
          setText(event.target.value);
        }}
      />
    </label>
  );
}
