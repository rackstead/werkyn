// Test cleanup: removes the failed sign-in counters of the given addresses
// (each address's slot in "LoginThrottle"; see src/modules/auth/login-throttle.ts).
const { loginSlot, loginThrottle } = await import(
  "../../../src/modules/auth/login-throttle.ts"
);

export async function forgetSignInFailures(prisma, emails) {
  const { slots } = loginThrottle().policy;
  const slotsOf = emails.map((email) => loginSlot(email.toLowerCase(), slots));
  await prisma.loginThrottle.deleteMany({ where: { slot: { in: slotsOf } } });
}
