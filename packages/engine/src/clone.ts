/** Состояние партии — чистый JSON, поэтому глубокое копирование через сериализацию. */
export const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
