import { z } from "zod";

export const SENDER_ADDRESS_GUIDANCE =
  'From address must be a single mailbox, such as sender@example.com or "Werkyn, Team" <sender@example.com>, without line breaks, comments or groups';

const emailAddress = z.email();
const controls = /[\u0000-\u001f\u007f-\u009f]/;

/** A deliberately small mailbox grammar shared by settings and both send paths. */
export function parseSenderMailbox(
  value: string,
): { name: string; address: string } | undefined {
  if (value.length > 255 || controls.test(value)) return undefined;
  const text = value.trim();
  if (emailAddress.safeParse(text).success) return { name: "", address: text };

  const match = /^(.+?)\s*<([^<>]+)>$/.exec(text);
  if (!match || !emailAddress.safeParse(match[2]).success) return undefined;
  const display = match[1].trim();
  let name: string;
  if (display.startsWith('"')) {
    // Quotes and backslashes are supported only with explicit escaping.
    if (!/^"(?:[^"\\]|\\["\\])*"$/.test(display)) return undefined;
    name = display.slice(1, -1).replace(/\\(["\\])/g, "$1");
  } else {
    // RFC comments, groups, lists and encoded parser syntax are not accepted.
    if (/["<>()[\]:;,@\\]/.test(display)) return undefined;
    name = display;
  }
  if (!name.trim()) return undefined;
  return { name, address: match[2] };
}

/** Empty means use the existing sender fallback; invalid nonempty values never do. */
export const SenderAddressSchema = z
  .string()
  .max(255, SENDER_ADDRESS_GUIDANCE)
  .refine(
    (value) =>
      !controls.test(value) &&
      (value.trim() === "" || !!parseSenderMailbox(value)),
    SENDER_ADDRESS_GUIDANCE,
  )
  .transform((value) => value.trim());

export const UpdateEmailConfigSchema = z.object({
  host: z.string().max(255).optional(),
  port: z.coerce.number().int().min(1).max(65535).optional(),
  secure: z.boolean().optional(),
  user: z.string().max(255).optional(),
  pass: z.string().max(500).optional(),
  fromAddress: SenderAddressSchema.optional(),
});

export type UpdateEmailConfigInput = z.infer<typeof UpdateEmailConfigSchema>;
