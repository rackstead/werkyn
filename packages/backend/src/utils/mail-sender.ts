import { parseSenderMailbox, SENDER_ADDRESS_GUIDANCE } from "@pm/shared";

export function requireSenderMailbox(value: string) {
  const mailbox = parseSenderMailbox(value);
  if (!mailbox)
    throw Object.assign(new Error(SENDER_ADDRESS_GUIDANCE), {
      code: "EADDRESS",
    });
  return mailbox;
}
