//go:build !linux && !darwin && !freebsd && !dragonfly

package main

// readDiskUsage 在本项目未支持的平台上返回「取不到」。
//
// 为什么要有这个文件，而不是让编译直接失败：
//
// build 约束如果只写受支持的平台（linux || darwin || freebsd || dragonfly），
// 那么在别的平台上 `readDiskUsage` 这个标识符**根本不存在** —— 于是
// main.go 的调用处变成 `undefined: readDiskUsage`，整份代码编译不过。
// 「这台机器上没有磁盘数据」与「这个平台编不出 agent」是两件事：
// 后者意味着用户连装都装不上，而前者只少一行指标。
//
// 真的编不过的平台实测如下（`GOARCH=amd64 go build`）：
//
//	· netbsd / solaris —— 有 syscall.Statfs_t，但字段名不同
//	  （netbsd 是 F_bsize/F_blocks，solaris 干脆没有这个结构）
//	· openbsd         —— 字段同样叫 F_bsize
//	· windows         —— 没有 syscall.Statfs
//	· aix / js        —— 其他原因
//
// 所以这些平台**编译得出、但磁盘指标为空**。发布脚本只构建 linux 三个架构
// 与本机自测用的 darwin，因此正式产物不受影响。
//
// 返回 0,0 而不是编一个数字：界面据此显示「—」，用户能分辨
// 「这台机器报了 0」与「这台机器没报」。
func readDiskUsage(path string) (used float64, total float64) { return 0, 0 }
