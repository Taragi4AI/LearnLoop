// Pure, framework-free search-occurrence navigation for LearnLoop.
//
// Single source of truth for: ordered matches (ascending video time), the
// current selected index, next/previous with wrap, select(index), the
// "N of M" counter, and enabled/disabled state. Holds NO DOM / player refs so
// it is unit-testable in Node. The DOM layer renders counter + highlight and
// performs the seek via the existing validated seek path.
//
// Occurrence = one matching transcript segment.

export function createSearchNav() {
  let matches = [];   // result objects (have .seek / .start)
  let index = -1;     // -1 = no selection
  let query = '';

  return {
    get total() { return matches.length; },
    get index() { return index; },
    get current() { return index >= 0 && index < matches.length ? matches[index] : null; },
    get query() { return query; },

    /** Replace matches for a query. Resets selection to the first match when
     *  results exist (per spec). Returns the selected match or null. */
    setResults(newQuery, newMatches) {
      query = (newQuery || '').trim();
      matches = Array.isArray(newMatches) ? newMatches.slice() : [];
      index = matches.length > 0 ? 0 : -1;
      return this.current;
    },

    /** Advance one match with wrap-around. Selects first if none selected. */
    next() {
      if (matches.length === 0) { index = -1; return null; }
      index = index < 0 ? 0 : (index + 1) % matches.length;
      return this.current;
    },

    /** Move back one match with wrap-around. Selects last if none selected. */
    previous() {
      if (matches.length === 0) { index = -1; return null; }
      index = index < 0 ? matches.length - 1
                        : (index - 1 + matches.length) % matches.length;
      return this.current;
    },

    /** Select a specific index (row click). No-op if out of range. */
    select(i) {
      if (i < 0 || i >= matches.length) return null;
      index = i;
      return this.current;
    },

    /** "N of M" counter string, or '' when there are no matches. */
    counterText() {
      if (matches.length === 0) return '';
      return `${index + 1} of ${matches.length}`;
    },

    /** Whether Prev/Next/Auto-scan should be enabled. */
    canNavigate() { return matches.length > 0; },

    clear() { matches = []; index = -1; query = ''; },
  };
}
