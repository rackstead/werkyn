import { useEffect, useRef, useState } from "react";

type DateValue = string | null;

/**
 * Keep the latest inline date edit across editor remounts and save edits in
 * order. A refetch may still show the old value while a write is pending;
 * comparing against it would drop a quick correction back to that value.
 */
export function useInlineDateSave(
  saved: DateValue,
  send: (date: DateValue) => Promise<boolean>,
  required = false,
) {
  const [, refresh] = useState(0);
  const rendered = useRef(saved);
  rendered.current = saved;
  const confirmed = useRef(saved);
  const latest = useRef<{ value: DateValue } | null>(null);
  const queue = useRef<Array<{ value: DateValue; send: typeof send }>>([]);
  const running = useRef(false);

  useEffect(() => {
    if (running.current) return;
    // Once local writes have settled, a later server update may come from
    // another editor and is authoritative again.
    if (latest.current) {
      latest.current = null;
      refresh((version) => version + 1);
    }
    confirmed.current = saved;
  }, [saved]);

  const drain = async () => {
    running.current = true;
    while (queue.current.length) {
      const entry = queue.current.shift()!;
      let succeeded = false;
      try {
        succeeded = await entry.send(entry.value);
      } catch {
        // Mutation handlers already report the error. Keep retries possible.
      }
      if (succeeded) confirmed.current = entry.value;
      if (latest.current === entry) {
        latest.current = succeeded ? entry : { value: confirmed.current };
        if (latest.current.value === rendered.current) latest.current = null;
      }
    }
    running.current = false;
    refresh((version) => version + 1);
  };

  const current = () => latest.current ? latest.current.value : rendered.current;
  const save = (value: DateValue) => {
    if (value === current() || (required && value === null)) return;
    const entry = { value, send };
    latest.current = entry;
    queue.current.push(entry);
    if (!running.current) void drain();
  };

  return { value: current(), save };
}
