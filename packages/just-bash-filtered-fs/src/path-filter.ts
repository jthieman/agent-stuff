/**
 * Check if a virtual path is excluded by patterns or a filter function.
 *
 * Patterns match against each path segment individually:
 *   '.env'     - exact segment match
 *   '.env*'    - segment starts with '.env'
 *   '*.pem'    - segment ends with '.pem'
 *   '*secret*' - segment contains 'secret'
 */
export function isPathExcluded(
  virtualPath: string,
  patterns: string[],
  filterFn?: (path: string) => boolean,
): boolean {
  if (patterns.length === 0 && !filterFn) return false;

  if (filterFn && !filterFn(virtualPath)) return true;

  if (patterns.length > 0) {
    const segments = virtualPath.split("/").filter(Boolean);
    for (const segment of segments) {
      for (const pattern of patterns) {
        if (matchSegment(segment, pattern)) return true;
      }
    }
  }

  return false;
}

/**
 * Match a single path segment against a simple pattern.
 *   'foo'   - exact
 *   'foo*'  - starts with
 *   '*foo'  - ends with
 *   '*foo*' - contains
 */
export function matchSegment(segment: string, pattern: string): boolean {
  const startsWild = pattern.startsWith("*");
  const endsWild = pattern.endsWith("*");

  if (startsWild && endsWild) {
    const inner = pattern.slice(1, -1);
    return inner === "" || segment.includes(inner);
  }
  if (startsWild) return segment.endsWith(pattern.slice(1));
  if (endsWild) return segment.startsWith(pattern.slice(0, -1));
  return segment === pattern;
}
