import { z } from "zod";

/** Magic-link email. */
export const emailSchema = z
  .email("Enter a valid email address")
  .max(254, "That email address is too long");

/**
 * The two required consent checkboxes. Unchecked boxes are absent from
 * FormData, so both fields must arrive as the literal string "on".
 */
export const consentSchema = z.object({
  open_datasets: z.literal("on", {
    error: "Please confirm how your contributions will be used",
  }),
  rights: z.literal("on", {
    error: "Please confirm you have the right to share what you submit",
  }),
});

/** Optional display name, stored on the profile. */
export const displayNameSchema = z
  .string()
  .trim()
  .min(1, "Display name cannot be empty")
  .max(80, "Keep the display name under 80 characters");
