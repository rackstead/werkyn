import { z } from "zod";
import { singleLineText } from "./common.js";

const passwordField = z
  .string()
  .min(8, "Password must be at least 8 characters")
  .max(128, "Password must be 128 characters or less")
  .regex(
    /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/,
    "Password must include uppercase, lowercase, and a number",
  );

export const LoginSchema = z.object({
  email: z.string().email("Invalid email address"),
  password: z.string().min(1, "Password is required"),
});
export type LoginInput = z.infer<typeof LoginSchema>;

export const RegisterSchema = z.object({
  email: z.string().email("Invalid email address"),
  password: passwordField,
  displayName: singleLineText()
    .min(1, "Display name is required")
    .max(100, "Display name must be 100 characters or less"),
  inviteToken: z.string().optional(),
});
export type RegisterInput = z.infer<typeof RegisterSchema>;

export const ForgotPasswordSchema = z.object({
  email: z.string().email("Invalid email address"),
});
export type ForgotPasswordInput = z.infer<typeof ForgotPasswordSchema>;

export const ResetPasswordSchema = z.object({
  password: passwordField,
});
export type ResetPasswordInput = z.infer<typeof ResetPasswordSchema>;

export const ChangePasswordSchema = z.object({
  currentPassword: z.string().min(1, "Current password is required"),
  newPassword: passwordField,
});
export type ChangePasswordInput = z.infer<typeof ChangePasswordSchema>;
