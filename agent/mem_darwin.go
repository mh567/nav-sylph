//go:build darwin

package main

import (
	"os/exec"
	"strconv"
	"strings"
)

// totalMemoryBytes 取物理内存总量。
// 用 sysctl 而不是 cgo，避免为一个小数引入编译工具链依赖——
// agent 的全部意义就是「拷过去就能跑」。
func totalMemoryBytes() float64 {
	v, _ := sysctlUint64("hw.memsize")
	return float64(v)
}

func pageSizeBytes() int {
	v, ok := sysctlUint64("hw.pagesize")
	if !ok || v == 0 {
		return 4096
	}
	return int(v)
}

func sysctlUint64(name string) (uint64, bool) {
	out, err := exec.Command("sysctl", "-n", name).Output()
	if err != nil {
		return 0, false
	}
	s := strings.TrimSpace(string(out))
	v, err := strconv.ParseUint(s, 10, 64)
	if err != nil {
		return 0, false
	}
	return v, true
}
