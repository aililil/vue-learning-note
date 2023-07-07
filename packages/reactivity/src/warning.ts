// 封装用于自定义报错
export function warn(msg: string, ...args: any[]) {
  console.warn(`[Vue warn] ${msg}`, ...args)
}
