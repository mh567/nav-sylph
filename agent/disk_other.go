//go:build linux || darwin || freebsd || dragonfly

package main

import "syscall"

// readDiskUsage 返回给定路径所在文件系统的已用量与总量（字节）。
//
// 口径 = `Blocks - Bfree`（乘 Bsize）。`Bfree` 与 `Bavail` 在本机 macOS 上
// **实测完全相同**（都是 41936381），所以两者算出来的数也一样；取 Bfree
// 只是因为它在 BSD 与 Linux 上都表示「连 root 都算空闲」，语义更贴近字面。
//
// ⚠️ **与 `df` 的数对不上，而且这不是 bug**：本机 macOS（APFS）实测
//
//	statfs: Blocks-Bfree = 300.5 GiB / 460.4 GiB = 65.3%
//	df -k /: Used        =  12.7 GiB / 460.4 GiB =  2.8%
//
// 差 24 倍。APFS 的「已分配」包含其他卷共享的可回收快照与本地快照，
// 而 `df` 报的 Used 是当前实际落盘的数据。statfs 给不出后者——
// 那需要 `df` 依赖的 APFS 专有接口。所以这里如实报 statfs 的口径，
// 并**不**声称它等于 `df`。
//
// 界面上这个差异不会误导用户，因为它显示的是「这台机器的磁盘占用」，
// 不是「与 df 完全一致」。真要跟 df 对齐得走 `unix.Statfs` 之外的路子，
// 代价是引入平台专有代码——而这个项目只有 NAS / Linux 机器会真的部署它。
//
// ⚠️ 另一条曾经写在这里的错误注释：它说「Linux 的 Bsize 已经是字节，
// 乘出来会差 512 倍」，并据此声称要按 GOOS 分开实现。**那是错的**，没有依据。
// 查 Linux man page（statfs(2)）：`f_bsize` 是 "optimal transfer block size"、
// `f_blocks` 是 "total data blocks in file system" —— 与 BSD 语义一致，两边都要乘。
// 两平台唯一差别是字段**类型**（Linux int64 / Darwin uint32），
// 而 `float64(...)` 把这点也抹平了。一个实现就够；按错误的注释分平台，
// 只会引入一份没有理由存在的重复代码，下次有人「修正」它还要再查一遍。
//
// 取不到时返回 0,0，界面显示「—」：编一个假值比留空更糟。
func readDiskUsage(path string) (used float64, total float64) {
	var st syscall.Statfs_t
	if err := syscall.Statfs(path, &st); err != nil {
		return 0, 0
	}
	blockSize := float64(st.Bsize)
	total = float64(st.Blocks) * blockSize
	used = total - float64(st.Bfree)*blockSize
	if total <= 0 || used < 0 {
		return 0, 0
	}
	return used, total
}
