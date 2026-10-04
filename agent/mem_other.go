//go:build !darwin

package main

import "os"

// totalMemoryBytes 无 /proc 且非 darwin 时的回落：读不到就返回 0，
// 于是 memoryPercent 为 0、内存显示为「—」，而不是编一个数字出来。
func totalMemoryBytes() float64 { return 0 }

func pageSizeBytes() int { return 4096 }

var _ = os.Getpid
