/**
 * Deep merge two objects recursively
 * @param target The target object to merge into
 * @param source The source object to merge from
 * @returns The merged object
 */
export function deepMerge<T extends Record<string, any>>(target: T, source: Partial<T>): T {
  // Create a copy of the target object
  const output = { ...target } as Record<string, any>;

  // If source is not an object, return the target object
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    return output as T;
  }

  // Iterate through source properties
  Object.keys(source).forEach(key => {
    const sourceValue = source[key as keyof typeof source];
    const targetValue = output[key];

    // Handle arrays - use source array directly
    if (Array.isArray(sourceValue)) {
      output[key] = sourceValue;
      return;
    }

    // Handle nested objects - recursively merge
    if (
      sourceValue &&
      typeof sourceValue === 'object' &&
      targetValue &&
      typeof targetValue === 'object' &&
      !Array.isArray(targetValue)
    ) {
      output[key] = deepMerge(targetValue, sourceValue as Record<string, any>);
      return;
    }

    // For primitive values or if targetValue is not an object,
    // use the source value directly
    if (sourceValue !== undefined) {
      output[key] = sourceValue;
    }
  });

  return output as T;
}
