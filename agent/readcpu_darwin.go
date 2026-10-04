//go:build darwin

package main

// osCpuTotal 是无 /proc 时的累计 CPU 时间回落路径。
//
// ⚠️ **实测结论（macOS 14 / darwin-arm64）：这条路径拿不到数据，返回 false。**
//
//	sysctl -n kern.cp_time → unknown oid（该 sysctl 在现代 macOS 已移除）
//	sysctl -n kern.clockrate → 格式是 `{ hz = 100, tick = 10000, ... }`，
//	  不是裸数字，所以「取 Fields[0] 当 HZ」也会失败
//
// 拿到数据需要 cgo 调 host_statistics() 或 host_processor_info()，
// 那会破坏「静态二进制、拷过去就能跑」这个前提——而这正是选 Go 的唯一理由。
//
// 所以这里**返回 false 而不是编一个数**：collect() 于是把 CPU 留成 null，
// 界面上显示「—」。理由有二：
//  1. 一个假值比缺失更有害——用户会以为 CPU 一直很低或一直很高。
//     Node 版 agent 曾把「数组减数字」算出 NaN，JSON 完全合法、看不出出错。
//  2. 正式支持的平台只有 Linux（见 README）；darwin 产物仅供本机开发自测。
//
// 若将来确实要在 macOS 上给出 CPU 数字，正确做法是引入 cgo 并在 README 里
// 说明「darwin 版需要本机编译」——而不是在这里塞一个看起来能用的估算。
func osCpuTotal() (cpuTimes, bool) { return cpuTimes{}, false }
