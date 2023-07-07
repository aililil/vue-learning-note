import { TrackOpTypes, TriggerOpTypes } from './operations'
import { extend, isArray, isIntegerKey, isMap } from '@vue/shared'
import { EffectScope, recordEffectScope } from './effectScope'
import {
  createDep,
  Dep,
  finalizeDepMarkers,
  initDepMarkers,
  newTracked,
  wasTracked
} from './dep'
import { ComputedRefImpl } from './computed'

// The main WeakMap that stores {target -> key -> dep} connections.
// Conceptually, it's easier to think of a dependency as a Dep class
// which maintains a Set of subscribers, but we simply store them as
// raw Sets to reduce memory overhead.
type KeyToDepMap = Map<any, Dep>
const targetMap = new WeakMap<any, KeyToDepMap>() // 全局数据 存储响应式对象及其依赖的映射关系

// The number of effects currently being tracked recursively.
let effectTrackDepth = 0  // effect递归深度标记
// dep.n 和 dep.w使用bit表示深度，同时优化了时间、空间复杂度，v3.2
export let trackOpBit = 1 // 当前深度的二进制表示

/**
 * The bitwise track markers support at most 30 levels of recursion.
 * This value is chosen to enable modern JS engines to use a SMI on all platforms.
 * When recursion depth is greater, fall back to using a full cleanup.
 * 正整数左移操作的最大步长为30
 */
const maxMarkerBits = 30

export type EffectScheduler = (...args: any[]) => any

export type DebuggerEvent = {
  effect: ReactiveEffect
} & DebuggerEventExtraInfo

export type DebuggerEventExtraInfo = {
  target: object
  type: TrackOpTypes | TriggerOpTypes
  key: any
  newValue?: any
  oldValue?: any
  oldTarget?: Map<any, any> | Set<any>
}

export let activeEffect: ReactiveEffect | undefined // 当前正在收集依赖的effect。effect收集依赖时会将自己挂在全局，方便响应式数据收集。

export const ITERATE_KEY = Symbol(__DEV__ ? 'iterate' : '') // 用于array存储dep的键名
export const MAP_KEY_ITERATE_KEY = Symbol(__DEV__ ? 'Map key iterate' : '') // 用于map存储dep的键名

export class ReactiveEffect<T = any> {
  active = true // 实例是否有效
  deps: Dep[] = []  // effect实例依赖的响应式数据数组
  parent: ReactiveEffect | undefined = undefined

  /**
   * Can be attached after creation
   * @internal
   */
  computed?: ComputedRefImpl<T>
  /**
   * @internal
   */
  allowRecurse?: boolean
  /**
   * @internal
   */
  private deferStop?: boolean
  // effect失效时触发的响应式
  onStop?: () => void
  // dev only 实例追踪依赖时触发的回调
  onTrack?: (event: DebuggerEvent) => void
  // dev only 实例被通知更新时触发的回调
  onTrigger?: (event: DebuggerEvent) => void
  // 响应式副作用构造器
  constructor(
    public fn: () => T, // 传入的副作用函数
    public scheduler: EffectScheduler | null = null,
    scope?: EffectScope
  ) {
    // 存入 effect 作用域
    recordEffectScope(this, scope)
  }

  run() {
    if (!this.active) { // 副作用依然有效
      return this.fn()
    }
    // 存在effect嵌套时
    let parent: ReactiveEffect | undefined = activeEffect
    let lastShouldTrack = shouldTrack // 暂存全局标识 方便后面还原
    // 防止循环调用 如：effect(() => object++)
    while (parent) {
      if (parent === this) {
        return
      }
      parent = parent.parent
    }
    try {
      this.parent = activeEffect  // 存储父实例
      activeEffect = this
      shouldTrack = true  // 允许track

      trackOpBit = 1 << ++effectTrackDepth  // 深度加一

      if (effectTrackDepth <= maxMarkerBits) {
        // 3.2优化点
        initDepMarkers(this)
      } else {
        // 降级方案：每次执行前 清除dep 执行时会方便重新收集 存在性能瓶颈
        cleanupEffect(this)
      }
      return this.fn()
    } finally {
      if (effectTrackDepth <= maxMarkerBits) {
        finalizeDepMarkers(this)
      }
      // 依赖收集完成 还原全局变量和临时数据
      trackOpBit = 1 << --effectTrackDepth
      activeEffect = this.parent
      shouldTrack = lastShouldTrack
      this.parent = undefined

      if (this.deferStop) {
        this.stop()
      }
    }
  }

  // 使当前实例的响应式失活，等待清除工作的统一执行
  stop() {
    // stopped while running itself - defer the cleanup
    if (activeEffect === this) {
      this.deferStop = true
    } else if (this.active) {
      cleanupEffect(this)
      if (this.onStop) {
        this.onStop()
      }
      this.active = false
    }
  }
}

function cleanupEffect(effect: ReactiveEffect) {
  const { deps } = effect
  if (deps.length) {
    // 从响应式数据上删除当前副作用
    for (let i = 0; i < deps.length; i++) {
      deps[i].delete(effect)
    }
    // 清空deps 后续重收集
    deps.length = 0
  }
}

export interface DebuggerOptions {
  onTrack?: (event: DebuggerEvent) => void
  onTrigger?: (event: DebuggerEvent) => void
}

export interface ReactiveEffectOptions extends DebuggerOptions {
  lazy?: boolean  // 是否是lazy effect
  scheduler?: EffectScheduler // 自定义的调度器
  scope?: EffectScope
  allowRecurse?: boolean
  onStop?: () => void // effect失效时的回调
}

export interface ReactiveEffectRunner<T = any> {
  (): T
  effect: ReactiveEffect
}

/**
 * Registers the given function to track reactive updates.
 *
 * The given function will be run once immediately. Every time any reactive
 * property that's accessed within it gets updated, the function will run again.
 *
 * @param fn - The function that will track reactive updates.
 * @param options - Allows to control the effect's behaviour.
 * @returns A runner that can be used to control the effect after creation.
 */
// 生成一个effect的工厂函数
export function effect<T = any>(
  fn: () => T,
  options?: ReactiveEffectOptions
): ReactiveEffectRunner {
  // 已经是个effect实例
  if ((fn as ReactiveEffectRunner).effect) {
    fn = (fn as ReactiveEffectRunner).effect.fn
  }
  // 将fn处理为响应式副作用函数
  const _effect = new ReactiveEffect(fn)
  // 处理配置
  if (options) {
    extend(_effect, options)
    if (options.scope) recordEffectScope(_effect, options.scope)
  }
  // 非lazy effect 则立即执行（即立即收集依赖）
  if (!options || !options.lazy) {  // lazy effect
    _effect.run()
  }
  const runner = _effect.run.bind(_effect) as ReactiveEffectRunner
  runner.effect = _effect
  return runner
}

/**
 * Stops the effect associated with the given runner.
 * 使一个 effect runner 失效
 * @param runner - Association with the effect to stop tracking.
 */
export function stop(runner: ReactiveEffectRunner) {
  runner.effect.stop()
}

export let shouldTrack = true   // 当前是否允许track的标识
const trackStack: boolean[] = []

/**
 * Temporarily pauses tracking.
 */
export function pauseTracking() {
  trackStack.push(shouldTrack)
  shouldTrack = false
}

/**
 * Re-enables effect tracking (if it was paused).
 */
export function enableTracking() {
  trackStack.push(shouldTrack)
  shouldTrack = true
}

/**
 * Resets the previous global effect tracking state.
 */
export function resetTracking() {
  const last = trackStack.pop()
  shouldTrack = last === undefined ? true : last
}

/**
 * Tracks access to a reactive property.
 *
 * This will check which effect is running at the moment and record it as dep
 * which records all effects that depend on the reactive property.
 *
 * @param target - Object holding the reactive property.
 * @param type - Defines the type of access to the reactive property.
 * @param key - Identifier of the reactive property to track.
 */
// 响应式数据收集依赖的入口
export function track(target: object, type: TrackOpTypes, key: unknown) {
  if (shouldTrack && activeEffect) {
    // 获取响应式数据（target）存放依赖的map表
    let depsMap = targetMap.get(target)
    if (!depsMap) { // 没有则新建一个
      targetMap.set(target, (depsMap = new Map()))
    }
    let dep = depsMap.get(key)  // effect依赖的是响应式数据中的具体某个值。获取该值存放依赖的set表
    if (!dep) { // 没有则新建一个
      depsMap.set(key, (dep = createDep()))
    }

    const eventInfo = __DEV__
      ? { effect: activeEffect, target, type, key }
      : undefined
    // 通知依赖更新
    trackEffects(dep, eventInfo)
  }
}
// track的核心方法
export function trackEffects(
  dep: Dep,
  debuggerEventExtraInfo?: DebuggerEventExtraInfo // dev环境时，track执行时会触发一个回调
) {
  let shouldTrack = false // 是否应追踪标记
  if (effectTrackDepth <= maxMarkerBits) {
    if (!newTracked(dep)) {
      dep.n |= trackOpBit // set newly tracked
      shouldTrack = !wasTracked(dep)  // 当前深度是否已追踪
    }
  } else {  // 降级方案
    // Full cleanup mode.
    shouldTrack = !dep.has(activeEffect!) // 已经完成了响应式数据的追踪
  }

  if (shouldTrack) {
    // 双向指针
    dep.add(activeEffect!)  // 响应式数据中存储effect 
    activeEffect!.deps.push(dep)  // effect实例中存储响应式数据
    if (__DEV__ && activeEffect!.onTrack) { // dev环境触发tark回调
      activeEffect!.onTrack(
        extend(
          {
            effect: activeEffect!
          },
          debuggerEventExtraInfo!
        )
      )
    }
  }
}

/**
 * Finds all deps associated with the target (or a specific property) and
 * triggers the effects stored within.
 *
 * @param target - The reactive object.
 * @param type - Defines the type of the operation that needs to trigger effects.
 * @param key - Can be used to target a specific reactive property in the target object.
 */
// 通知依赖更新的核心方法
export function trigger(
  target: object, // 响应式数据
  type: TriggerOpTypes, // 响应式数据的响应类型
  key?: unknown,
  newValue?: unknown,
  oldValue?: unknown,
  oldTarget?: Map<unknown, unknown> | Set<unknown>
) {
  const depsMap = targetMap.get(target) // 获取依赖响应式数据（target）的effect
  if (!depsMap) {
    // 无需要触发的effect
    return
  }

  // 筛选出需要执行的effect
  let deps: (Dep | undefined)[] = []  // 用于存放最终需要执行的effect
  if (type === TriggerOpTypes.CLEAR) {
    // map clear 需要全部触发更新
    // collection being cleared
    // trigger all effects for target
    deps = [...depsMap.values()]
  } else if (key === 'length' && isArray(target)) {
    // 数组长度变化 通知订阅了长度变化的effect
    const newLength = Number(newValue)
    depsMap.forEach((dep, key) => {
      if (key === 'length' || key >= newLength) {
        deps.push(dep)
      }
    })
  } else {
    // 响应式数据发生set add delet 操作
    // schedule runs for SET | ADD | DELETE
    if (key !== void 0) {
      deps.push(depsMap.get(key)) // 通知监听key值变化的effect
    }

    // also run for iteration key on ADD | DELETE | Map.SET
    switch (type) {
      case TriggerOpTypes.ADD:
        if (!isArray(target)) {
          deps.push(depsMap.get(ITERATE_KEY))
          if (isMap(target)) {
            deps.push(depsMap.get(MAP_KEY_ITERATE_KEY))
          }
        } else if (isIntegerKey(key)) {
          // new index added to array -> length changes
          deps.push(depsMap.get('length'))
        }
        break
      case TriggerOpTypes.DELETE:
        if (!isArray(target)) {
          deps.push(depsMap.get(ITERATE_KEY))
          if (isMap(target)) {
            deps.push(depsMap.get(MAP_KEY_ITERATE_KEY))
          }
        }
        break
      case TriggerOpTypes.SET:
        if (isMap(target)) {
          deps.push(depsMap.get(ITERATE_KEY))
        }
        break
    }
  }
  // info for onTrigger hook
  const eventInfo = __DEV__
    ? { target, type, key, newValue, oldValue, oldTarget }
    : undefined
  // 通知依赖更新
  if (deps.length === 1) {  // 优化时间复杂度
    if (deps[0]) {
      if (__DEV__) {
        triggerEffects(deps[0], eventInfo)
      } else {
        triggerEffects(deps[0])
      }
    }
  } else {
    const effects: ReactiveEffect[] = []
    for (const dep of deps) {
      if (dep) {
        effects.push(...dep)
      }
    }
    if (__DEV__) {
      triggerEffects(createDep(effects), eventInfo)
    } else {
      triggerEffects(createDep(effects))
    }
  }
}

export function triggerEffects(
  dep: Dep | ReactiveEffect[],
  debuggerEventExtraInfo?: DebuggerEventExtraInfo
) {
  // spread into array for stabilization  类数组转为数组
  const effects = isArray(dep) ? dep : [...dep]
  // 优先触发computed类型的effect。因为其他effect会将computed视为ref类型读取value，因此执行顺序会影响结果。
  for (const effect of effects) {
    if (effect.computed) {
      triggerEffect(effect, debuggerEventExtraInfo)
    }
  }
  for (const effect of effects) {
    if (!effect.computed) {
      triggerEffect(effect, debuggerEventExtraInfo)
    }
  }
}

function triggerEffect(
  effect: ReactiveEffect,
  debuggerEventExtraInfo?: DebuggerEventExtraInfo
) {
  if (effect !== activeEffect || effect.allowRecurse) {
    if (__DEV__ && effect.onTrigger) {
      effect.onTrigger(extend({ effect }, debuggerEventExtraInfo))
    }
    // effect是否存在自定义的调度器
    if (effect.scheduler) {
      effect.scheduler()
    } else {
      effect.run()
    }
  }
}

export function getDepFromReactive(object: any, key: string | number | symbol) {
  return targetMap.get(object)?.get(key)
}
