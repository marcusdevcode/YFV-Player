// A small JSON Schema validator for the keywords our schemas use. The full validator (ajv) builds
// code at run time, which the app's content security policy forbids, so the app checks data with
// this instead; `npm run validate:json` checks the shipped files with ajv.
// Supported: type, const, enum, pattern, minLength, maxLength, minimum, maximum, minItems, items,
// required, properties, patternProperties, additionalProperties.

type Schema = Record<string, any>;

const typeOf = (v: unknown) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);

/** The problems found, each as "path message"; an empty list means the data is valid. */
export function validate(schema: Schema, data: unknown, path = ""): string[] {
  const errors: string[] = [];
  const at = path || "/";
  const type = typeOf(data);

  if (schema.type) {
    const ok = schema.type === "integer" ? Number.isInteger(data) : schema.type === type;
    if (!ok) return [`${at} must be ${schema.type}`];
  }
  if ("const" in schema && data !== schema.const) errors.push(`${at} must be ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.includes(data)) errors.push(`${at} must be one of ${schema.enum.join(", ")}`);

  if (type === "string") {
    const text = data as string;
    if (schema.pattern && !new RegExp(schema.pattern).test(text)) errors.push(`${at} has the wrong format`);
    if (schema.minLength !== undefined && text.length < schema.minLength) errors.push(`${at} is too short`);
    if (schema.maxLength !== undefined && text.length > schema.maxLength) errors.push(`${at} is too long`);
  }
  if (type === "number") {
    const n = data as number;
    if (schema.minimum !== undefined && n < schema.minimum) errors.push(`${at} must be at least ${schema.minimum}`);
    if (schema.maximum !== undefined && n > schema.maximum) errors.push(`${at} must be at most ${schema.maximum}`);
  }
  if (type === "array") {
    const list = data as unknown[];
    if (schema.minItems !== undefined && list.length < schema.minItems) errors.push(`${at} needs at least ${schema.minItems} items`);
    if (schema.items) list.forEach((item, i) => errors.push(...validate(schema.items, item, `${path}/${i}`)));
  }
  if (type === "object") {
    const obj = data as Record<string, unknown>;
    for (const key of schema.required ?? []) if (!(key in obj)) errors.push(`${at} is missing "${key}"`);
    for (const [key, value] of Object.entries(obj)) {
      const child = `${path}/${key}`;
      if (schema.properties && key in schema.properties) {
        errors.push(...validate(schema.properties[key], value, child));
        continue;
      }
      const pattern = Object.keys(schema.patternProperties ?? {}).find((p) => new RegExp(p).test(key));
      if (pattern) {
        errors.push(...validate(schema.patternProperties[pattern], value, child));
        continue;
      }
      if (schema.additionalProperties === false) errors.push(`${child} is not allowed here`);
      else if (typeof schema.additionalProperties === "object") errors.push(...validate(schema.additionalProperties, value, child));
    }
  }
  return errors;
}
