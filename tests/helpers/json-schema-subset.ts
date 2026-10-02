export type JsonSchemaDocument = {
  $id?: unknown;
  properties?: Record<string, unknown>;
  required?: unknown[];
  additionalProperties?: unknown;
  items?: JsonSchemaDocument;
  enum?: unknown[];
  const?: unknown;
  type?: unknown;
  minLength?: unknown;
  maxLength?: unknown;
  minItems?: unknown;
  maxItems?: unknown;
  minimum?: unknown;
  maximum?: unknown;
  pattern?: unknown;
  oneOf?: JsonSchemaDocument[];
  $defs?: Record<string, JsonSchemaDocument>;
  $ref?: unknown;
};

function resolveLocalRef(schema: JsonSchemaDocument, ref: string): JsonSchemaDocument {
  const prefix = "#/$defs/";
  if (!ref.startsWith(prefix)) {
    throw new Error(`Unsupported test schema ref: ${ref}`);
  }
  const key = ref.slice(prefix.length);
  const resolved = schema.$defs?.[key];
  if (!resolved) {
    throw new Error(`Missing schema ref ${ref}`);
  }
  return resolved;
}

export function validateAgainstSubset(
  schema: JsonSchemaDocument,
  value: unknown,
  rootSchema = schema,
): string[] {
  if (typeof schema.$ref === "string") {
    return validateAgainstSubset(resolveLocalRef(rootSchema, schema.$ref), value, rootSchema);
  }

  const errors: string[] = [];
  const schemaType = schema.type;
  if (Array.isArray(schema.oneOf)) {
    const matchCount = schema.oneOf.filter(
      (candidate) => validateAgainstSubset(candidate, value, rootSchema).length === 0
    ).length;
    if (matchCount !== 1) {
      errors.push(`expected exactly one oneOf match, got ${matchCount}`);
    }
  }
  if (schema.const !== undefined && value !== schema.const) {
    errors.push(`expected const ${String(schema.const)}`);
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    errors.push(`expected one of ${schema.enum.join(",")}`);
  }
  if (schemaType === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return [`expected object`];
    }
    const objectValue = value as Record<string, unknown>;
    const properties = schema.properties ?? {};
    for (const requiredKey of schema.required ?? []) {
      if (typeof requiredKey === "string" && !Object.hasOwn(objectValue, requiredKey)) {
        errors.push(`missing ${requiredKey}`);
      }
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(objectValue)) {
        if (!Object.hasOwn(properties, key)) {
          errors.push(`unexpected ${key}`);
        }
      }
    }
    for (const [key, propertySchema] of Object.entries(properties)) {
      if (Object.hasOwn(objectValue, key)) {
        errors.push(
          ...validateAgainstSubset(
            propertySchema as JsonSchemaDocument,
            objectValue[key],
            rootSchema,
          ).map((error) => `${key}.${error}`),
        );
      }
    }
    return errors;
  }
  if (schemaType === "array") {
    if (!Array.isArray(value)) {
      return [`expected array`];
    }
    if (typeof schema.minItems === "number" && value.length < schema.minItems) {
      errors.push(`minItems ${schema.minItems}`);
    }
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
      errors.push(`maxItems ${schema.maxItems}`);
    }
    if (schema.items) {
      value.forEach((entry, index) => {
        errors.push(
          ...validateAgainstSubset(schema.items!, entry, rootSchema).map(
            (error) => `${index}.${error}`,
          ),
        );
      });
    }
    return errors;
  }
  if (schemaType === "string") {
    if (typeof value !== "string") {
      return [`expected string`];
    }
    const codePointLength = [...value].length;
    if (typeof schema.minLength === "number" && codePointLength < schema.minLength) {
      errors.push(`minLength ${schema.minLength}`);
    }
    if (typeof schema.maxLength === "number" && codePointLength > schema.maxLength) {
      errors.push(`maxLength ${schema.maxLength}`);
    }
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern).test(value)) {
      errors.push(`pattern ${schema.pattern}`);
    }
  }
  if (schemaType === "null" && value !== null) {
    errors.push(`expected null`);
  }
  if (schemaType === "boolean" && typeof value !== "boolean") {
    errors.push(`expected boolean`);
  }
  if (schemaType === "integer") {
    if (!Number.isInteger(value)) {
      errors.push(`expected integer`);
    } else if (typeof value === "number") {
      if (typeof schema.minimum === "number" && value < schema.minimum) {
        errors.push(`minimum ${schema.minimum}`);
      }
      if (typeof schema.maximum === "number" && value > schema.maximum) {
        errors.push(`maximum ${schema.maximum}`);
      }
    }
  }
  if (schemaType === "number") {
    if (typeof value !== "number" || Number.isNaN(value)) {
      errors.push(`expected number`);
    } else {
      if (typeof schema.minimum === "number" && value < schema.minimum) {
        errors.push(`minimum ${schema.minimum}`);
      }
      if (typeof schema.maximum === "number" && value > schema.maximum) {
        errors.push(`maximum ${schema.maximum}`);
      }
    }
  }
  return errors;
}
