import {
  DAYKEEPER_FLOW_SCHEMA_VERSION,
  type CreateFlowInput,
  type CreateFlowVersionInput,
  type EmailChannelSpec,
  type TenantSpec,
} from "@skyporch/daykeeper";
import { z } from "zod";
import { CliError } from "./errors.ts";

const text = (minimum: number, maximum: number) =>
  z
    .string()
    .min(minimum)
    .max(maximum)
    .refine((value) => value.trim().length >= minimum);
const name = text(2, 120);
const slug = z
  .string()
  .min(1)
  .max(63)
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/);
const email = z.email().max(254);
const integer = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const actionId = text(1, 64);
const definition = z.strictObject({
  schemaVersion: z.literal(DAYKEEPER_FLOW_SCHEMA_VERSION),
  trigger: z.strictObject({
    event: z.enum(["conversation.created", "message.received"]),
    channel: z.literal("email"),
  }),
  conditions: z
    .array(
      z.strictObject({
        field: z.enum([
          "contact.email_domain",
          "conversation.tag",
          "message.text",
        ]),
        operator: z.enum(["equals", "contains", "ends_with"]),
        value: text(1, 500),
      }),
    )
    .max(20),
  actions: z
    .array(
      z.discriminatedUnion("type", [
        z.strictObject({
          id: actionId,
          type: z.literal("reply"),
          text: text(1, 4000),
        }),
        z.strictObject({
          id: actionId,
          type: z.literal("tag"),
          tag: text(1, 64),
        }),
        z.strictObject({
          id: actionId,
          type: z.literal("handoff"),
          target: z.enum(["agent", "human", "hybrid"]),
        }),
        z.strictObject({
          id: actionId,
          type: z.literal("set_priority"),
          priority: z.enum(["low", "medium", "high", "urgent"]),
        }),
      ]),
    )
    .min(1)
    .max(25)
    .refine(
      (actions) =>
        new Set(actions.map((action) => action.id)).size === actions.length,
    ),
});

const tenant = z.strictObject({
  name,
  slug,
  locale: text(2, 35),
  region: text(2, 35).optional(),
  supportEmail: email.optional(),
  administrator: z.strictObject({ name, email }),
}) satisfies z.ZodType<TenantSpec>;

const channel = z.strictObject({
  address: email,
  region: z
    .enum(["us-east-1", "eu-west-1", "sa-east-1", "ap-northeast-1"])
    .optional(),
}) satisfies z.ZodType<EmailChannelSpec>;

const flow = z.strictObject({
  name,
  slug,
  description: text(1, 500).optional(),
  definition,
}) satisfies z.ZodType<CreateFlowInput>;

const flowVersion = z.strictObject({
  expectedLatestVersion: integer,
  definition,
}) satisfies z.ZodType<CreateFlowVersionInput>;

export const inputSchemas = { tenant, channel, flow, flowVersion };
export type InputKind = keyof typeof inputSchemas;

export function validateInput<Kind extends InputKind>(
  kind: Kind,
  value: unknown,
) {
  const parsed = inputSchemas[kind].safeParse(value);
  if (!parsed.success) {
    const fields = [
      ...new Set(
        parsed.error.issues.map((issue) => ["input", ...issue.path].join(".")),
      ),
    ].slice(0, 32);
    throw new CliError(
      "INVALID_INPUT",
      "The JSON input does not match the command contract.",
      fields,
    );
  }
  return parsed.data;
}

export function resourceId(value: string | undefined, field: string): string {
  if (
    !value ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value,
    )
  ) {
    throw new CliError(
      "INVALID_ARGUMENT",
      "Resource identifiers must be UUIDs.",
      [field],
    );
  }
  return value;
}

export function positiveInteger(
  value: string | undefined,
  field: string,
): number {
  if (
    !value ||
    !/^[1-9][0-9]*$/.test(value) ||
    !Number.isSafeInteger(Number(value))
  ) {
    throw new CliError(
      "INVALID_ARGUMENT",
      "Versions and limits must be positive safe integers.",
      [field],
    );
  }
  return Number(value);
}

export function idempotencyKey(value: string | undefined): string {
  if (!value || !/^[A-Za-z0-9._:-]{16,128}$/.test(value)) {
    throw new CliError(
      "INVALID_ARGUMENT",
      "An idempotency key must contain 16–128 URL-safe characters.",
      ["idempotency-key"],
    );
  }
  return value;
}
