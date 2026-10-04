//go:build !darwin

package main

// osCpuTotal 是「无 /proc」时的回落。
//
// Linux 上有 /proc，所以正常不会走到这里；精简容器里 /proc 可能没挂载。
//
// ⚠️ 关键约束：**返回的形状必须与 /proc 分支逐字一致**。
// Node 版 agent 曾在这里翻车——回落分支返回按核的数组而 /proc 分支返回
// 聚合对象，于是「数组减数字」= NaN，totalDelta > 0 不成立，CPU 恒为 null，
// 而返回的 JSON 完全合法、看不出出错，只是一直没有 CPU 数据。
//
// 这里读不到就返回 false，让 collect() 把 CPU 留成 null（界面显示「—」），
// 而不是造一个假值出来。
func osCpuTotal() (cpuTimes, bool) { return cpuTimes{}, false }
