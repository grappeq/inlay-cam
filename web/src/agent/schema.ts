// The part of JSON Schema the commands describe their input with, and a
// check of an input against it. A key a command does not take is refused by
// name: a misspelt one is never dropped in silence.

export interface Schema {
  type?: "object" | "string" | "number" | "integer" | "boolean" | "array";
  description?: string;
  properties?: Record<string, Schema>;
  required?: string[];
  /** Absent on an object with properties means false here: only the keys named are taken. */
  additionalProperties?: boolean;
  items?: Schema;
  enum?: (string | number)[];
  minimum?: number;
  exclusiveMinimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  /** Also takes null, which a command reads as "none" or "take it away". */
  nullable?: boolean;
}

/** An object that takes the keys named and no others. */
export function object(properties: Record<string, Schema>, required: string[] = []): Schema {
  return { type: "object", properties, required, additionalProperties: false };
}

/** What is wrong with `value` as an input of `schema`, as a sentence; null when nothing is. */
export function problemWith(value: unknown, schema: Schema, at = "input"): string | null {
  if (value === null && schema.nullable) return null;
  if (schema.enum && !schema.enum.includes(value as string | number)) return `${at} must be one of ${schema.enum.map((v) => JSON.stringify(v)).join(", ")}`;
  switch (schema.type) {
    case "string":
      return typeof value === "string" ? null : `${at} must be a text`;
    case "boolean":
      return typeof value === "boolean" ? null : `${at} must be true or false`;
    case "number":
    case "integer": {
      if (typeof value !== "number" || !Number.isFinite(value)) return `${at} must be a number`;
      if (schema.type === "integer" && !Number.isInteger(value)) return `${at} must be a whole number`;
      if (schema.minimum !== undefined && value < schema.minimum) return `${at} must be ${schema.minimum} or more`;
      if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) return `${at} must be greater than ${schema.exclusiveMinimum}`;
      if (schema.maximum !== undefined && value > schema.maximum) return `${at} must be ${schema.maximum} or less`;
      return null;
    }
    case "array": {
      if (!Array.isArray(value)) return `${at} must be a list`;
      if (schema.minItems !== undefined && value.length < schema.minItems) return `${at} must have ${schema.minItems} or more entries`;
      if (schema.maxItems !== undefined && value.length > schema.maxItems) return `${at} must have ${schema.maxItems} or fewer entries`;
      for (const [i, item] of value.entries()) {
        const problem = schema.items ? problemWith(item, schema.items, `${at}[${i}]`) : null;
        if (problem) return problem;
      }
      return null;
    }
    case "object": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) return `${at} must be an object`;
      const given = value as Record<string, unknown>;
      const known = schema.properties ?? {};
      for (const key of schema.required ?? []) if (given[key] === undefined) return `${at}.${key} is needed`;
      for (const [key, item] of Object.entries(given)) {
        if (item === undefined) continue;
        if (known[key]) {
          const problem = problemWith(item, known[key], `${at}.${key}`);
          if (problem) return problem;
        } else if (schema.properties && schema.additionalProperties !== true) {
          return `${at}.${key} is not something this command takes. It takes: ${Object.keys(known).join(", ") || "nothing"}`;
        }
      }
      return null;
    }
    default:
      return null;
  }
}
