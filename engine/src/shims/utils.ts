export function flatten(items) {
  return items.reduce((result, item) => result.concat(item), []);
}
