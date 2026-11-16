import { useEffect, useState } from "react";

/**
 * Debounce any fast-changing value (Phase 6 Feature 2: extracted verbatim
 * from PurchasesReturn.tsx into a shared hook).
 */
export function useDebouncedValue<T>(value: T, delay = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}
