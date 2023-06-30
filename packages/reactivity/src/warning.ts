// 自定义报错信息
export function warn(msg: string, ...args: any[]) {
  console.warn(`[Vue warn] ${msg}`, ...args)
}
