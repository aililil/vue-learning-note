// using literal strings instead of numbers so that it's easier to inspect
// debugger events
// 收集依赖，依赖的类型（观察者监听响应式数据，具体以何种方法监听响应式数据）
export const enum TrackOpTypes {
  GET = 'get',  // 读取
  HAS = 'has',  // key in obj
  ITERATE = 'iterate' // iterator forEach, for of
}
// 通知更新，更新的类型 （响应式数据发生变化时，会通知观察者发生自己发生了具体的哪种变化）
export const enum TriggerOpTypes {
  SET = 'set',  // 设值操作
  ADD = 'add', // 对象追加属性
  DELETE = 'delete', // 删除属性
  CLEAR = 'clear' // map实例上clear方法
}
