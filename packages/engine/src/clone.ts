/** Состояние партии — чистый JSON, поэтому глубокое копирование через сериализацию. */
export const clone = <T>(x: T): T => (x === undefined ? x : (JSON.parse(JSON.stringify(x)) as T));
