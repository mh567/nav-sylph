// Nav Sylph 监控 agent
//
// 部署在**被监控的目标机**上，让 Nav Sylph 服务能读到这台机器的 CPU、内存与负载。
// 本服务只能读到运行它自己的那台主机；要读别的机器，目标机上就得有一个东西去读
// 系统计数器并把结果吐出来——这就是 agent 的全部职责。
//
// 为什么是 Go 而不是 shell 或 Node：
//   - 零运行时依赖。静态二进制拷过去就能跑，NAS / 路由器 / 精简容器上不需要先装 Node。
//   - crypto/x509 **能原生签发证书**。Node 内置 crypto 只有 X509Certificate（只能解析），
//     所以 Node 版 agent 被迫调 openssl CLI——Go 不需要，openssl 这个依赖因此消失。
//   - 能起带鉴权的 HTTPS 服务。纯 shell 做不到：openssl s_server 没有鉴权。
//
// 跨平台：Linux 读 /proc，darwin 用 vm_stat（os 层面的 freemem 在 macOS 上不代表
// 可用内存——它把大量内存拿去做文件缓存，实测会显示成「内存 99%」）。
package main

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

// VERSION 是**协议版本**，必须与服务端 server.js 的 AGENT_PROTOCOL_VERSION 一致。
// 不一致时服务端会明确报错，而不是把不认识的字段当成 0 读进去
// （那样会显示「CPU 0%」这种错误结论）。
//
// ⚠️ 它**不是软件版本**。指标载荷的字段没变就是同一个协议，agent 换了几个
// 版本不该让服务端报「协议不一致」。
// 软件版本是 buildVersion，两者混用会让「升级了 agent」变成「协议坏了」。
const VERSION = 1

// buildVersion 是**软件版本**，由构建脚本用 -ldflags 注入，形如 "1.6.8"。
//
// 为什么必须在编译期注入：升级命令要知道「我手上这个二进制是哪一版」，
// 而版本号是发布时决定的。写死在源码里就得改一次源码、编译一次，
// 还要记得同步 tag——三处各自漂移。
// 留空时回落到 "dev"，让「从源码直接 go build 的产物」能被识别出来，
// 而不是伪装成某个正式版本。
var buildVersion = "dev"

// agentVersion 返回软件版本号，供 version 子命令与 /health 上报。
func agentVersion() string {
	if buildVersion == "" {
		return "dev"
	}
	return buildVersion
}

// cpuSampleGap 是两次 CPU 采样之间的间隔。累计值只能靠做差得到百分比，
// 间隔太短则差值接近噪声。
const cpuSampleGap = 200 * time.Millisecond

// 上报的周期白名单，与服务端 server.js 的 POLL_INTERVALS 逐项一致。
// 两侧不一致时，正常配置会自己把自己限掉（表现是间歇性 429）。
var pushIntervals = []int{10, 15, 30, 60, 300}

const (
	pushBackoffMax = 5 * time.Minute
	pushTimeout    = 8 * time.Second
	remoteTimeout  = 8 * time.Second
)

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}
	cmd := os.Args[1]
	args := parseArgs(os.Args[2:])
	var err error
	switch cmd {
	case "enroll":
		err = cmdEnroll(args)
	case "serve":
		err = cmdServe(args)
	case "push":
		err = cmdPush(args)
	case "collect":
		err = cmdCollect()
	case "health":
		err = cmdHealth(args)
	case "upgrade":
		err = cmdUpgrade(args)
	case "version", "--version", "-v":
		// --raw 只输出版本号本身，供脚本与 upgrade 解析。
		//
		// ⚠️ 为什么不让 upgrade 去解析上面那行人类可读输出：那份格式里
		// 带着中文括号与逗号（实测踩过——按空白切第 2 段拿到的是
		// "1.6.7（协议"，然后被当成版本号去比较）。让一个脚本去解析
		// 给人看的字符串，任何一次改文案都会静默弄坏它。
		// 机器可读的字段就该有一个只输出它的入口。
		if args.has("raw") {
			fmt.Println(agentVersion())
			break
		}
		fmt.Printf("nav-agent %s（协议 v%d，%s/%s，%s）\n",
			agentVersion(), VERSION, runtime.GOOS, runtime.GOARCH, runtime.Version())
	case "help", "--help", "-h":
		usage()
	default:
		fmt.Fprintf(os.Stderr, "未知子命令：%s\n\n", cmd)
		usage()
		os.Exit(2)
	}
	if err != nil {
		fmt.Fprintf(os.Stderr, "错误：%v\n", err)
		os.Exit(1)
	}
}

func usage() {
	fmt.Print(`nav-agent — Nav Sylph 监控 agent

用法：
  nav-agent enroll --server <本服务地址> --token <一次性令牌> [--server-ca <PEM>]
      注册并落盘配置。生成自签证书（不需要 openssl），把证书交给本服务，
      换回长期凭据写入 /etc/nav-agent/。
      --server-ca 只在本服务用自签证书时才需要（把它当作可信根）。

  nav-agent serve [--tls-cert ... --tls-key ...] [--host 0.0.0.0] [--port 4195]
      拉取模式：起一个带 Bearer 鉴权的 HTTPS 服务等本服务来连。

  nav-agent push --secret <推送凭据> --server-id <id> [--interval 15]
      推送模式：只做出站连接，不监听任何端口。

  nav-agent collect      打印一份指标 JSON（调试用）
  nav-agent health       自检：配置、证书、连通性
  nav-agent upgrade --server <地址> [--server-ca <PEM>]
      从本服务下载并替换自己。自动按本机架构选产物
      （amd64 / arm64 / armv7）；配置与凭据不动。
      结束时自动重启 nav-agent 服务（systemd）；重启不了会打印手动步骤。
  nav-agent version      版本（软件版本 + 协议版本）

说明：
  凭据从环境变量读更安全——命令行参数会出现在 ps 输出与 shell 历史里。
    NAV_AGENT_TOKEN      拉取模式的 Bearer token
    NAV_AGENT_PUSH_SECRET 推送凭据
    NAV_AGENT_SERVER_ID  推送模式的目标机器 id
    NAV_AGENT_SERVER_CA  本服务证书的 CA（自签时才需要）
    NAV_AGENT_HOME       配置目录，默认 /etc/nav-agent（仅测试用）
`)
}

// ========== 参数 ==========

type options map[string]string

func parseArgs(argv []string) options {
	out := options{}
	for i := 0; i < len(argv); i++ {
		a := argv[i]
		if !strings.HasPrefix(a, "--") {
			continue
		}
		name := strings.TrimPrefix(a, "--")
		// --flag=value 形式
		if eq := strings.Index(name, "="); eq >= 0 {
			out[name[:eq]] = name[eq+1:]
			continue
		}
		// --flag 后面跟值；但已知布尔开关不带值
		if isBoolFlag(name) && (i+1 >= len(argv) || strings.HasPrefix(argv[i+1], "--")) {
			out[name] = "true"
			continue
		}
		if i+1 < len(argv) {
			out[name] = argv[i+1]
			i++
		} else {
			out[name] = "true"
		}
	}
	return out
}

func isBoolFlag(name string) bool {
	switch name {
	case "help", "expose-hostname", "insecure-http", "verbose":
		return true
	}
	return false
}

func (o options) str(name, def string) string {
	if v, ok := o[name]; ok && v != "" {
		return v
	}
	return def
}

func (o options) has(name string) bool {
	_, ok := o[name]
	return ok
}

func (o options) num(name string, def int) int {
	if v, ok := o[name]; ok {
		if n, err := strconv.Atoi(strings.TrimSpace(v)); err == nil {
			return n
		}
	}
	return def
}

// pick 取一个配置值，flag 优先于环境变量。
//
// 顺序是有意的：环境变量更安全——命令行参数会出现在 ps 输出与 shell 历史里。
//
// ⚠️ 两者都 TrimSpace：凭据常经由「命令输出重定向到文件再 source」这类路径，
// 尾随的换行会一起进来。而 token 比较是定长的，多一个 \n 就永远不相等——
// 症状是 agent 一直报「凭据被拒」，而用户看到的 token 与后台**一模一样**。
// 端到端实测踩过：把响应写进文件时带了换行，鉴权 401。
func (o options) pick(flagName, envName, def string) string {
	if v, ok := o[flagName]; ok && strings.TrimSpace(v) != "" {
		return strings.TrimSpace(v)
	}
	if v := os.Getenv(envName); strings.TrimSpace(v) != "" {
		return strings.TrimSpace(v)
	}
	return def
}

// ========== 采集 ==========

// cpuTimes 是 /proc/stat 第一行的聚合形状。
//
// ⚠️ 两条采集路径必须返回**同一种形状**。Node 版曾在这里翻车：/proc 分支返回
// 聚合对象、os.cpus() 分支返回按核的数组，于是「数组减数字」= NaN，
// totalDelta > 0 不成立，cpu 恒为 null——而返回的 JSON 完全合法，
// 看不出出错，只是一直没有 CPU 数据。所以这里只有一种形状。
type cpuTimes struct {
	User, Nice, System, Idle, Iowait, Irq, Total float64
}

func hasProc() bool {
	_, err := os.Stat("/proc/stat")
	return err == nil
}

// readProcStat 读 /proc/stat 第一行，返回各状态的累计 tick 数。
func readProcStat() (cpuTimes, bool) {
	raw, err := os.ReadFile("/proc/stat")
	if err != nil {
		return cpuTimes{}, false
	}
	for _, line := range strings.Split(string(raw), "\n") {
		if !strings.HasPrefix(line, "cpu ") {
			continue
		}
		parts := strings.Fields(line)
		get := func(i int) float64 {
			if i < len(parts) {
				f, _ := strconv.ParseFloat(parts[i], 64)
				return f
			}
			return 0
		}
		t := cpuTimes{
			User: get(1), Nice: get(2), System: get(3),
			Idle: get(4), Iowait: get(5), Irq: get(6),
		}
		// user nice system idle iowait irq softirq steal
		for i := 1; i < len(parts); i++ {
			f, _ := strconv.ParseFloat(parts[i], 64)
			t.Total += f
		}
		return t, true
	}
	return cpuTimes{}, false
}

var (
	previousCpu     cpuTimes
	previousCpuOnce sync.Once
)

func readCpuTotal() (cpuTimes, bool) {
	if hasProc() {
		if t, ok := readProcStat(); ok {
			return t, true
		}
	}
	return readOsCpuTotal()
}

// readOsCpuTotal 读「累计 CPU 时间」的回落路径。字段与 /proc 分支同名同序，
// 否则「数组减数字」会算出 NaN、CPU 恒为 null，而 JSON 仍合法、看不出出错。
// 平台相关的实现放在 readcpu_darwin.go / readcpu_other.go。
func readOsCpuTotal() (cpuTimes, bool) { return osCpuTotal() }

type memory struct{ Total, Used, Available float64 }

// readMemory 读内存。
//
// macOS 上**不能用「总内存 − 空闲」**：vm_free 之外的页面大部分被内核拿去做文件缓存，
// 实测 16GB 机器上会显示成「内存 99%」，看着像要爆，实际完全正常。
// 那个差值衡量的是缓存占用，不是应用占用。与 Node 版 agent 口径一致：
// 可用 = free + inactive + speculative + purgeable。
func readMemory() memory {
	if runtime.GOOS == "darwin" {
		return readDarwinMemory()
	}
	raw, err := os.ReadFile("/proc/meminfo")
	if err != nil {
		return memory{}
	}
	field := func(label string) float64 {
		for _, line := range strings.Split(string(raw), "\n") {
			if !strings.HasPrefix(line, label+":") {
				continue
			}
			parts := strings.Fields(line)
			if len(parts) < 2 {
				return 0
			}
			// meminfo 的单位是 kB
			kb, _ := strconv.ParseFloat(parts[1], 64)
			return kb * 1024
		}
		return 0
	}
	total := field("MemTotal")
	available := field("MemAvailable")
	if available == 0 {
		available = field("MemFree")
	}
	return memory{Total: total, Used: max(total-available, 0), Available: available}
}

func readDarwinMemory() memory {
	pageSize := float64(pageSizeBytes())
	out, err := exec.Command("vm_stat").Output()
	if err != nil {
		return memory{Total: totalMemoryBytes()}
	}
	lines := strings.Split(string(out), "\n")
	// ⚠️ vm_stat 的标签是**词组**（"Pages free:"），所以 Fields[1] 是 "free:"
	// 而不是数字——按下标取第一段会 ParseFloat("free:") 失败、返回 0，
	// 于是「可用内存 = 0」显示成「内存 100%」。要匹配整行、再取最后一段。
	value := func(label string) float64 {
		for _, line := range lines {
			if !strings.HasPrefix(line, label+":") {
				continue
			}
			fields := strings.Fields(line)
			if len(fields) < 2 {
				return 0
			}
			raw := fields[len(fields)-1] // 末段是数字，形如 "13878."
			f, err := strconv.ParseFloat(strings.TrimSuffix(raw, "."), 64)
			if err != nil {
				return 0
			}
			return f * pageSize
		}
		return 0
	}
	total := totalMemoryBytes()
	// inactive 是可回收的文件缓存，算作可用才是用户视角
	available := value("Pages free") + value("Pages inactive") +
		value("Pages speculative") + value("Pages purgeable")
	used := max(total-available, 0)
	return memory{Total: total, Used: min(used, total), Available: available}
}

// metrics 是上报载荷。**字段名与顺序必须与 Node 版 agent 逐字一致**——
// 服务端 normalizePushedMetrics 按名字校验，少一个或改一个都会被拒。
type metrics struct {
	Version       int      `json:"version"`
	CPU           *float64 `json:"cpu"`
	MemoryUsed    float64  `json:"memoryUsed"`
	MemoryTotal   float64  `json:"memoryTotal"`
	MemoryPercent float64  `json:"memoryPercent"`
	// 磁盘占用：根文件系统的总量与已用量。
	// DiskTotal <= 0 表示取不到（受限容器里 statfs 可能失败），
	// 此时界面显示「—」，而不是编一个数字。
	DiskUsed  float64 `json:"diskUsed"`
	DiskTotal float64 `json:"diskTotal"`
	Load1     float64 `json:"load1"`
	Load5     float64 `json:"load5"`
	Uptime    float64 `json:"uptime"`
	Cores     int     `json:"cores"`
	Hostname  string  `json:"hostname"`
	Platform  string  `json:"platform"`
	SampledAt int64   `json:"sampledAt"`
}

// collect 采一份完整指标。CPU 必须两次采样做差，所以这里会等 cpuSampleGap。
func collect() (*metrics, error) {
	previousCpuOnce.Do(func() {
		if t, ok := readCpuTotal(); ok {
			previousCpu = t
		}
	})
	prev := previousCpu
	time.Sleep(cpuSampleGap)
	cur, ok := readCpuTotal()

	// ⚠️ CPU 读不到**不是致命错误**：内存、负载、主机名都还能报，
	// 而让整个采集失败会把一台完全正常的机器显示成「离线」。
	// 所以这里只把 cpu 留成 null（界面显示「—」），不返回错误。
	// 一个假值比缺失更有害——用户会以为 CPU 一直很低或一直很高。
	var cpu *float64
	if ok {
		previousCpu = cur
		totalDelta := cur.Total - prev.Total
		idleDelta := (cur.Idle - prev.Idle) + (cur.Iowait - prev.Iowait)
		if totalDelta > 0 {
			v := 1 - idleDelta/totalDelta
			v = min(max(v, 0), 1)
			cpu = &v
		}
	}

	mem := readMemory()
	load1, load5 := readLoadAvg()
	// 磁盘读不到同样不是致命错误：与 CPU 一样留 0（= 界面显示「—」），
	// 而不是编一个数字或让整台机器显示成离线。
	diskUsed, diskTotal := readDiskUsage("/")

	m := &metrics{
		Version:     VERSION,
		CPU:         cpu,
		MemoryUsed:  mem.Used,
		MemoryTotal: mem.Total,
		DiskUsed:    diskUsed,
		DiskTotal:   diskTotal,
		Uptime:      sysUptime(),
		Cores:       runtime.NumCPU(),
		Hostname:    sysHostname(),
		Platform:    runtime.GOOS,
		SampledAt:   time.Now().UnixMilli(),
	}
	if mem.Total > 0 {
		m.MemoryPercent = mem.Used / mem.Total
	}
	m.Load1, m.Load5 = load1, load5
	return m, nil
}

// ========== 证书 ==========

// selfSign 生成一对密钥与一张自签证书。
//
// 这是选 Go 的主要原因之一：crypto/x509 能**签发**，而 Node 的 crypto 只能解析。
// SAN 必须给——现代 TLS 校验先看 SAN，CN 只是回退；缺了它连接会直接失败。
func selfSign(hostname string) (certPEM, keyPEM []byte, fp string, err error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, nil, "", fmt.Errorf("生成私钥失败：%w", err)
	}
	serialLimit := new(big.Int).Lsh(big.NewInt(1), 128)
	serial, err := rand.Int(rand.Reader, serialLimit)
	if err != nil {
		return nil, nil, "", fmt.Errorf("生成序列号失败：%w", err)
	}
	now := time.Now()
	tmpl := x509.Certificate{
		SerialNumber:          serial,
		Subject:               pkix.Name{CommonName: hostname, Organization: []string{"Nav Sylph agent"}},
		NotBefore:             now.Add(-time.Hour), // 容忍一点时钟偏差
		NotAfter:              now.AddDate(10, 0, 0),
		KeyUsage:              x509.KeyUsageDigitalSignature | x509.KeyUsageCertSign,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		BasicConstraintsValid: true,
		IsCA:                  true, // 自签证书要能给自己签名
	}
	if ip := net.ParseIP(hostname); ip != nil {
		tmpl.IPAddresses = []net.IP{ip}
	} else {
		tmpl.DNSNames = []string{hostname}
	}
	tmpl.IPAddresses = append(tmpl.IPAddresses, net.ParseIP("127.0.0.1"), net.ParseIP("::1"))

	der, err := x509.CreateCertificate(rand.Reader, &tmpl, &tmpl, &key.PublicKey, key)
	if err != nil {
		return nil, nil, "", fmt.Errorf("签发证书失败：%w", err)
	}
	keyDER, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		return nil, nil, "", fmt.Errorf("序列化私钥失败：%w", err)
	}
	certPEM = pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	keyPEM = pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER})

	sum := sha256.Sum256(der)
	fp = strings.ToUpper(hex.EncodeToString(sum[:]))
	var segs []string
	for i := 0; i < len(fp); i += 2 {
		segs = append(segs, fp[i:i+2])
	}
	return certPEM, keyPEM, strings.Join(segs, ":"), nil
}

func fingerprintOfPEM(p []byte) string {
	blk, _ := pem.Decode(p)
	if blk == nil {
		return ""
	}
	sum := sha256.Sum256(blk.Bytes)
	fp := strings.ToUpper(hex.EncodeToString(sum[:]))
	var segs []string
	for i := 0; i < len(fp); i += 2 {
		segs = append(segs, fp[i:i+2])
	}
	return strings.Join(segs, ":")
}

// ========== 配置 ==========

const (
	defaultConfigDir = "/etc/nav-agent"
)

// configDir / configFile 是变量而不是常量，因为要能被环境变量覆盖：
// 端到端测试必须能在非 root 环境里跑完整的 enroll。
//
// ⚠️ 这个覆盖最初不存在，于是 enroll 这条路径**从未被端到端执行过**——
// 结果是它 100% 失败（agent 发出的 JSON 里漏了 token，服务端回 400），
// 而二进制编译通过、全部单元测试全绿、代码审计也没看出来。
// 一个组件间的字段契约，只有真把两个程序放在一起跑一次才会暴露；
// 「两边各自都有测试」不等于「它们对得上」。
//
// 仅供测试与非标准部署使用；systemd 里不设它，走默认的 /etc/nav-agent。
var (
	configDir  = envOr("NAV_AGENT_HOME", defaultConfigDir)
	configFile = filepath.Join(configDir, "config.json")
)

func envOr(key, def string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return def
}

// enrollClient 返回连本服务用的 HTTP 客户端。
//
// ⚠️ 默认的 http.DefaultClient 只认系统根证书池，而 Go 在 macOS 上**不读**
// SSL_CERT_FILE / SSL_CERT_DIR（那是 Linux 行为，macOS 走系统 Keychain），
// GODEBUG=x509usefallbackroots=1 实测也无效。
// 于是自托管用户（用自签证书跑 nav-sylph，而不是 certbot）会让 agent
// 在 enroll 这一步就握手失败，报「certificate signed by unknown authority」——
// 而这不是「明文不可用」那条安全要求想要的结果，只是让自签部署完全不可用。
//
// 所以显式提供 --server-ca：安装脚本从后台已存的 certPem 取一份带过去。
// 证书不是用户能自己生成的东西（它本来就是本服务签发的），所以这里给的是
// 文件路径而不是 PEM 字符串——命令行传 PEM 会出现在 ps 输出里。
func enrollClient(args options) *http.Client {
	// ⚠️ 第二参数是**字面默认值**，不是环境变量名（`str(name, def)`）。
	// 早先写成 args.str("server-ca", "NAV_AGENT_SERVER_CA")，于是**不传该参数**
	// 时 caPath 是字符串 "NAV_AGENT_SERVER_CA"，去读这个文件当然失败，每次
	// enroll / upgrade 都白打一行「读取 --server-ca 失败：open NAV_AGENT_SERVER_CA…」。
	// 功能没坏（随后回落 http.DefaultClient），但那行字会让人以为配置错了。
	// 与 --server 那处（`os.Getenv("NAV_AGENT_SERVER")`）保持一致。
	caPath := args.str("server-ca", os.Getenv("NAV_AGENT_SERVER_CA"))
	if caPath == "" {
		return http.DefaultClient
	}
	pem, err := os.ReadFile(caPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "读取 --server-ca 失败：%v\n", err)
		return http.DefaultClient
	}
	pool, err := x509.SystemCertPool()
	if err != nil || pool == nil {
		pool = x509.NewCertPool()
	}
	if !pool.AppendCertsFromPEM(pem) {
		fmt.Fprintf(os.Stderr, "--server-ca 里没有可用的证书：%s\n", caPath)
		return http.DefaultClient
	}
	return &http.Client{
		Transport: &http.Transport{TLSClientConfig: &tls.Config{RootCAs: pool}},
	}
}

type config struct {
	Server      string `json:"server"`
	ServerID    string `json:"serverId"`
	Mode        string `json:"mode"`
	Token       string `json:"token,omitempty"`      // 拉取模式的 Bearer token
	PushSecret  string `json:"pushSecret,omitempty"` // 推送凭据
	CertFile    string `json:"certFile,omitempty"`
	KeyFile     string `json:"keyFile,omitempty"`
	CertPEM     string `json:"certPem,omitempty"` // 注册时上报给服务端的那份
	Fingerprint string `json:"fingerprint,omitempty"`
	Host        string `json:"host,omitempty"`
	Port        int    `json:"port,omitempty"`
	Interval    int    `json:"interval,omitempty"`
}

func loadConfig() (*config, error) {
	raw, err := os.ReadFile(configFile)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, errors.New("尚未注册：没有 " + configFile + "，请先运行 nav-agent enroll")
		}
		return nil, fmt.Errorf("读配置失败：%w", err)
	}
	var c config
	if err := json.Unmarshal(raw, &c); err != nil {
		return nil, fmt.Errorf("配置损坏：%w", err)
	}
	return &c, nil
}

func saveConfig(c *config) error {
	if err := os.MkdirAll(configDir, 0o700); err != nil {
		return fmt.Errorf("创建 %s 失败：%w", configDir, err)
	}
	raw, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	// 配置里含 token 与推送凭据，权限必须收紧
	if err := os.WriteFile(configFile, raw, 0o600); err != nil {
		return fmt.Errorf("写配置失败：%w", err)
	}
	return os.Chmod(configFile, 0o600)
}

// ========== enroll ==========

// cmdEnroll 注册：生成自签证书，把证书交给本服务，换回长期凭据并落盘。
//
// 这一步取代了 Node 版的「手工生成证书 → 抄指纹 → 回后台核对 → 填 token」，
// 整个 TOFU 交互因此消失：令牌是一次性的，而证书是 agent 自己生成的。
func cmdEnroll(args options) error {
	server := strings.TrimRight(args.str("server", os.Getenv("NAV_AGENT_SERVER")), "/")
	token := args.pick("token", "NAV_AGENT_ENROLL_TOKEN", "")
	if server == "" {
		return errors.New("缺少 --server（本服务地址，如 https://nav.example.com）")
	}
	if token == "" {
		return errors.New("缺少 --token（后台生成的部署令牌，只需一次）")
	}
	mode := args.str("mode", "pull")
	if mode != "pull" && mode != "push" {
		return fmt.Errorf("--mode 只能是 pull 或 push，收到 %q", mode)
	}
	if _, err := url.Parse(server); err != nil {
		return fmt.Errorf("本服务地址无法解析：%s", server)
	}

	certPEM, keyPEM, fp, err := selfSign(sysHostname())
	if err != nil {
		return err
	}
	// 私钥先落盘：即使注册失败，证书也不用重新生成
	if err := os.MkdirAll(configDir, 0o700); err != nil {
		return fmt.Errorf("创建 %s 失败：%w", configDir, err)
	}
	certPath := filepath.Join(configDir, "cert.pem")
	keyPath := filepath.Join(configDir, "key.pem")
	if err := os.WriteFile(certPath, certPEM, 0o644); err != nil {
		return fmt.Errorf("写证书失败：%w", err)
	}
	if err := os.WriteFile(keyPath, keyPEM, 0o600); err != nil {
		return fmt.Errorf("写私钥失败：%w", err)
	}
	// 私钥必须是 0600：同机其它用户读到它就能冒充这台 agent
	if err := os.Chmod(keyPath, 0o600); err != nil {
		return fmt.Errorf("收紧私钥权限失败：%w", err)
	}

	// ⚠️ token 必须在这里，而且必须在 JSON body 里（不是只作为请求头）：
	// 服务端 enroll 端点读的是 `body.token`。曾经这个 map 里没有它，
	// 于是 NAS 上跑安装脚本稳定返回 HTTP 400「缺少令牌」——
	// agent 侧校验通过了（token 非空）、二进制编译通过、全部测试全绿，
	// 而真实调用 100% 失败：单元测试与形状断言都看不见两个组件之间的
	// 契约是否对得上，只有真把这两个程序放在一起跑一次才会暴露。
	body, _ := json.Marshal(map[string]string{
		"token":       token,
		"certPem":     string(certPEM),
		"certFile":    "cert.pem",
		"keyFile":     "key.pem",
		"fingerprint": fp,
		"mode":        mode,
		"hostname":    sysHostname(),
	})
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, "POST", server+"/api/modules/enroll", bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := enrollClient(args).Do(req)
	if err != nil {
		return fmt.Errorf("连不上本服务 %s：%w", server, err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("注册失败（HTTP %d）：%s", resp.StatusCode, firstLine(raw))
	}
	var out struct {
		ServerID   string `json:"serverId"`
		Token      string `json:"token"`
		PushSecret string `json:"pushSecret"`
		Mode       string `json:"mode"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return fmt.Errorf("注册响应无法解析：%w", err)
	}

	c := &config{
		Server:      server,
		ServerID:    out.ServerID,
		Mode:        out.Mode,
		Token:       out.Token,
		PushSecret:  out.PushSecret,
		CertFile:    certPath,
		KeyFile:     keyPath,
		CertPEM:     string(certPEM),
		Fingerprint: fp,
		Host:        args.str("host", "0.0.0.0"),
		Port:        args.num("port", 4195),
		Interval:    args.num("interval", 15),
	}
	if err := saveConfig(c); err != nil {
		return err
	}

	fmt.Println("注册成功。")
	fmt.Printf("  证书指纹 %s\n", fp)
	fmt.Printf("  配置已写入 %s（权限 600）\n", configFile)
	if c.Mode == "push" {
		fmt.Println("  模式：推送（不监听任何端口）")
	} else {
		fmt.Printf("  模式：拉取（监听 %s:%d）\n", c.Host, c.Port)
	}
	fmt.Println("  令牌用完即废，不会写进任何持久配置。")
	return nil
}

func firstLine(b []byte) string {
	s := strings.TrimSpace(string(b))
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		s = s[:i]
	}
	if len(s) > 300 {
		s = s[:300] + "…"
	}
	return s
}

// ========== serve（拉取模式） ==========

// cmdServe 起一个带 Bearer 鉴权的 HTTPS 服务。
//
// 缺证书时**拒绝启动**而不是降级去监听明文：token 是这台机器唯一的凭据，
// 明文传输等于把它公开在网络上。错误印在目标机终端，用户当场看得见。
func cmdServe(args options) error {
	certFile := args.str("tls-cert", "")
	keyFile := args.str("tls-key", "")
	host := args.str("host", "")
	port := args.num("port", -1)
	token := args.pick("token", "NAV_AGENT_TOKEN", "")

	if certFile == "" || keyFile == "" {
		var c *config
		if loaded, err := loadConfig(); err == nil {
			c = loaded
			if certFile == "" {
				certFile = c.CertFile
			}
			if keyFile == "" {
				keyFile = c.KeyFile
			}
			if token == "" {
				token = c.Token
			}
			if host == "" {
				host = c.Host
			}
			if port < 0 {
				port = c.Port
			}
		}
	}
	if certFile == "" || keyFile == "" {
		fmt.Fprint(os.Stderr, `拉取模式需要 TLS 证书：Bearer token 是这台机器的只读监控凭据，
走明文 HTTP 等于把它公开在网络上。

请先注册（会自动生成证书）：
  nav-agent enroll --server <本服务地址> --token <部署令牌>

确实要走明文（仅限已确认的可信网络）：加 --insecure-http
`)
		return errors.New("缺少 TLS 证书")
	}
	if token == "" {
		fmt.Fprint(os.Stderr, "缺少 token。请用环境变量 NAV_AGENT_TOKEN，"+
			"或确认已运行过 nav-agent enroll。\n")
		return errors.New("缺少 token")
	}
	if host == "" {
		host = "127.0.0.1"
	}
	if port <= 0 {
		port = 4195
	}
	insecure := args.has("insecure-http")

	mux := http.NewServeMux()
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		// /health 不需要鉴权（方便「agent 起来了吗」这类探测），所以**不能**返回
		// 主机名：它会跟着其它信息一起泄露这台机器叫什么、内网里怎么称呼它。
		// 需要主机名的人自己看 /metrics（那里要鉴权）。
		// ⚠️ `version` 是**协议**版本（服务端据此判断能不能解析载荷），
		// `agentVersion` 是**软件**版本（后台据此提示可以升级）。
		// 两个都放，因为它们回答不同的问题，混用会让「升级了 agent」
		// 变成「协议不一致」。
		payload := map[string]any{
			"status":       "ok",
			"version":      VERSION,
			"agentVersion": agentVersion(),
			"goarch":       runtime.GOARCH,
			"goos":         runtime.GOOS,
		}
		if args.has("expose-hostname") {
			payload["hostname"] = sysHostname()
		}
		writeJSON(w, http.StatusOK, payload)
	})
	mux.HandleFunc("/metrics", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "GET" {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
			return
		}
		if !tokenMatches(r.Header.Get("Authorization"), token) {
			// 不回显 token 的一部分——401 里带上任何提示都会帮攻击者
			w.Header().Set("WWW-Authenticate", `Bearer realm="nav-sylph"`)
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
			return
		}
		m, err := collect()
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		w.Header().Set("Cache-Control", "no-store")
		writeJSON(w, http.StatusOK, m)
	})

	srv := &http.Server{Addr: net.JoinHostPort(host, strconv.Itoa(port)), Handler: mux}
	scheme := "https"
	var ln net.Listener
	if insecure {
		scheme = "http"
	} else {
		cert, err := tls.LoadX509KeyPair(certFile, keyFile)
		if err != nil {
			return fmt.Errorf("读证书失败（--tls-cert %s / --tls-key %s）：%w", certFile, keyFile, err)
		}
		srv.TLSConfig = &tls.Config{
			Certificates: []tls.Certificate{cert},
			MinVersion:   tls.VersionTLS12,
		}
	}

	ln, err := net.Listen("tcp", srv.Addr)
	if err != nil {
		return fmt.Errorf("监听 %s 失败：%w", srv.Addr, err)
	}
	fmt.Printf("Nav Sylph agent %s\n", agentVersion())
	fmt.Printf("  主机名 %s\n", sysHostname())
	fmt.Printf("  监听 %s://%s\n", scheme, srv.Addr)
	if host == "127.0.0.1" {
		fmt.Println("  提示：只监听本机，跨机访问需 --host 0.0.0.0")
	}
	if !insecure {
		if raw, err := os.ReadFile(certFile); err == nil {
			fmt.Printf("  证书指纹 %s\n", fingerprintOfPEM(raw))
		}
	}

	// 优雅退出：systemd stop 发的是 SIGTERM，直接退出会被 Restart=always 立刻拉起，
	// 看起来像「停不下来」。
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	go func() {
		<-stop
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = srv.Shutdown(ctx)
	}()

	if insecure {
		err = srv.Serve(ln)
	} else {
		err = srv.ServeTLS(ln, "", "")
	}
	if err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}

// tokenMatches 定长比较，避免 token 逐字符比较时的时间差泄露前缀。
// 长度不同直接拒绝——攻击者本来也无法靠一次请求区分「长度不对」与「内容不对」，
// 但既然要防时序泄露，就不该在这里开一个口子。
func tokenMatches(provided, expected string) bool {
	if provided == "" || expected == "" {
		return false
	}
	// Authorization: Bearer xxx
	const prefix = "Bearer "
	if len(provided) > len(prefix) && strings.EqualFold(provided[:len(prefix)], prefix) {
		provided = provided[len(prefix):]
	}
	return subtle.ConstantTimeCompare([]byte(provided), []byte(expected)) == 1
}

// ========== push（推送模式） ==========

// cmdPush 只做出站连接，不监听任何端口——这是推送最大的安全收益。
func cmdPush(args options) error {
	secret := args.pick("push-secret", "NAV_AGENT_PUSH_SECRET", "")
	serverID := args.pick("server-id", "NAV_AGENT_SERVER_ID", "")
	server := strings.TrimRight(args.str("server", os.Getenv("NAV_AGENT_SERVER")), "/")
	interval := args.num("interval", -1)

	if secret == "" || serverID == "" || server == "" {
		var c *config
		if loaded, err := loadConfig(); err == nil {
			c = loaded
			if secret == "" {
				secret = c.PushSecret
			}
			if serverID == "" {
				serverID = c.ServerID
			}
			if server == "" {
				server = c.Server
			}
			if interval < 0 {
				interval = c.Interval
			}
		}
	}
	if secret == "" {
		return errors.New("缺少推送凭据。请用环境变量 NAV_AGENT_PUSH_SECRET，或先运行 nav-agent enroll")
	}
	if serverID == "" {
		return errors.New("缺少 server id。请用环境变量 NAV_AGENT_SERVER_ID")
	}
	if server == "" {
		return errors.New("缺少本服务地址")
	}
	if interval <= 0 {
		interval = 15
	}
	interval = resolveInterval(interval)

	fmt.Printf("Nav Sylph agent %s\n", agentVersion())
	fmt.Printf("  主机名 %s\n", sysHostname())
	fmt.Printf("  推送目标 %s/api/modules/agent-push\n", server)
	fmt.Printf("  上报间隔 %ds\n", interval)
	fmt.Printf("  server id %s\n", serverID)
	fmt.Println("  未监听任何端口（推送模式默认不开放端口）")

	client := &http.Client{Timeout: pushTimeout}
	backoff := time.Duration(0)
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)

	for {
		if m, err := collect(); err != nil {
			fmt.Fprintf(os.Stderr, "[push] 采集失败：%v\n", err)
		} else if ok := pushOnce(client, server, secret, serverID, m); ok {
			if backoff > 0 {
				fmt.Printf("[push] 恢复上报（退避 %ds）\n", int(backoff.Seconds()))
			}
			backoff = 0
		} else {
			if backoff == 0 {
				fmt.Fprintln(os.Stderr, "[push] 上报失败")
			}
			// 失败退避，上限 5 分钟。无脑按原周期重试会持续消耗服务端的限流桶，
			// 而那个桶按 IP 计数，一台机器的重试风暴会影响其它所有 agent。
			if backoff == 0 {
				backoff = 5 * time.Second
			} else {
				backoff *= 2
			}
			if backoff > pushBackoffMax {
				backoff = pushBackoffMax
			}
		}

		wait := time.Duration(interval) * time.Second
		if backoff > 0 {
			wait = backoff
		}
		select {
		case <-stop:
			fmt.Println("已停止推送。")
			return nil
		case <-time.After(wait):
		}
	}
}

func pushOnce(client *http.Client, server, secret, serverID string, m *metrics) bool {
	body, err := json.Marshal(map[string]any{
		"serverId": serverID,
		"metrics":  m,
	})
	if err != nil {
		return false
	}
	ctx, cancel := context.WithTimeout(context.Background(), pushTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, "POST", server+"/api/modules/agent-push", bytes.NewReader(body))
	if err != nil {
		return false
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+secret)
	resp, err := client.Do(req)
	if err != nil {
		fmt.Fprintf(os.Stderr, "[push] %v\n", err)
		return false
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
	if resp.StatusCode != http.StatusOK {
		fmt.Fprintf(os.Stderr, "[push] 上报失败：HTTP %d %s\n", resp.StatusCode, firstLine(raw))
		return false
	}
	return true
}

func resolveInterval(v int) int {
	for _, n := range pushIntervals {
		if n == v {
			return v
		}
	}
	return 15
}

// ========== collect / health ==========

func cmdCollect() error {
	m, err := collect()
	if err != nil {
		return err
	}
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	return enc.Encode(m)
}

// cmdHealth 自检：把「为什么连不上」拆成几个能分别回答的问题。
// 单看「失败」没有用——配置错、证书读不到、端口不通、token 不对，处置完全不同。
func cmdHealth(args options) error {
	fmt.Printf("nav-agent %s\n", agentVersion())
	fmt.Printf("  平台 %s/%s\n", runtime.GOOS, runtime.GOARCH)
	fmt.Printf("  主机名 %s\n", sysHostname())

	ok := true
	c, err := loadConfig()
	if err != nil {
		fmt.Printf("  ✗ 配置：%v\n", err)
		return err
	}
	fmt.Printf("  ✓ 配置 %s\n", configFile)
	fmt.Printf("    本服务 %s\n", c.Server)
	fmt.Printf("    模式   %s\n", c.Mode)
	if c.Mode == "push" {
		fmt.Printf("    凭据   已配置（不显示内容）\n")
	} else {
		if c.Token == "" {
			fmt.Println("    ✗ 缺少 token")
			ok = false
		} else {
			fmt.Println("    ✓ token 已配置（不显示内容）")
		}
		if _, err := os.Stat(c.CertFile); err != nil {
			fmt.Printf("    ✗ 证书不可读 %s\n", c.CertFile)
			ok = false
		} else {
			fmt.Printf("    ✓ 证书 %s\n", c.CertFile)
		}
		if raw, err := os.ReadFile(c.CertFile); err == nil {
			fmt.Printf("    指纹 %s\n", fingerprintOfPEM(raw))
		}
		if raw, err := os.ReadFile(c.KeyFile); err == nil {
			fi, _ := os.Stat(c.KeyFile)
			mode := "?"
			if fi != nil {
				mode = fi.Mode().Perm().String()
			}
			if len(raw) > 0 && mode != "-rw-------" {
				fmt.Printf("    ✗ 私钥权限 %s，应为 -rw-------\n", mode)
				ok = false
			} else {
				fmt.Printf("    ✓ 私钥权限 %s\n", mode)
			}
		}
	}

	m, err := collect()
	if err != nil {
		fmt.Printf("  ✗ 采集：%v\n", err)
		ok = false
	} else {
		cpuText := "—"
		if m.CPU != nil {
			cpuText = fmt.Sprintf("%.1f%%", *m.CPU*100)
		}
		fmt.Printf("  ✓ 采集 cpu=%s mem=%.1f%% cores=%d\n",
			cpuText, m.MemoryPercent*100, m.Cores)
	}

	if c.Mode == "pull" {
		addr := net.JoinHostPort("127.0.0.1", strconv.Itoa(c.Port))
		st := probeTCP(addr, 3*time.Second)
		fmt.Printf("  端口 %s：%s\n", addr, st.describe())
	}

	if !ok {
		return errors.New("自检未通过")
	}
	fmt.Println("自检通过。")
	return nil
}

// probeState 是 TCP 探测的三态。区分它们是「在线 / 未部署」得以成立的前提。
type probeState int

const (
	probeRefused probeState = iota
	probeOpen
	probeTimeout
	probeError
)

func (s probeState) describe() string {
	switch s {
	case probeRefused:
		return "连接被拒绝（主机在线，但端口没人监听）"
	case probeOpen:
		return "有服务在监听"
	case probeTimeout:
		return "超时（不可达）"
	default:
		return "出错"
	}
}

// ========== 自升级 ==========

// cmdUpgrade 从本服务下载新版本并替换自己。
//
// 为什么需要它：agent 装在**目标机**上，而用户在另一台机器（自己的电脑）
// 上操作后台。没有升级通道的话，改一个 agent 缺陷就要求用户 SSH 上目标机
// 重新跑一遍安装脚本——正是这个项目花力气消除的那种交互。
//
// 三个必须处理对的地方：
//
//  1. **替换正在运行的自己**。Linux 上可以覆写（ETXTBSY 只在**执行中**时
//     出现），但稳妥做法是写新文件再 rename——rename 是原子的，
//     不会出现「写了一半、二进制已损坏」的中间态。所以走临时文件 + rename。
//
//  2. **架构要对**。本机是 armv7 而下载的是 amd64，装上去当场崩。
//     所以按 runtime.GOARCH/GOARM 选产物，选不到就明说支持哪些。
//
//  3. **配置与凭据不能动**。它们在 configDir 里，与二进制无关。
//     而且升级失败时旧二进制必须还能用——所以先备份、替换后再校验、
//     校验不过就回滚。
func cmdUpgrade(args options) error {
	server := strings.TrimRight(args.str("server", os.Getenv("NAV_AGENT_SERVER")), "/")
	if server == "" {
		return errors.New("缺少 --server（本服务地址）")
	}

	arch, err := currentArch()
	if err != nil {
		return err
	}
	current := agentVersion()
	fmt.Printf("当前版本 %s（%s）\n", current, arch)

	url := fmt.Sprintf("%s/agent/nav-agent-linux-%s", server, arch)
	fmt.Printf("检查更新 %s\n", url)

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return err
	}
	// 自签的服务端要显式给 CA：Go 在 macOS 不读 SSL_CERT_FILE，
	// 在 Linux 上自签证书也不在系统根池里。
	resp, err := upgradeHTTPClient(args).Do(req)
	if err != nil {
		return fmt.Errorf("连不上本服务 %s：%w（自签证书请加 --server-ca）", server, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("下载失败（HTTP %d）：本服务可能没有这个架构的产物（%s）", resp.StatusCode, arch)
	}

	// 下载到临时文件再算校验，不能直接信任流。
	tmp, err := os.CreateTemp("", "nav-agent-*")
	if err != nil {
		return fmt.Errorf("创建临时文件失败：%w", err)
	}
	tmpPath := tmp.Name()
	defer os.Remove(tmpPath)

	written, err := io.Copy(tmp, io.LimitReader(resp.Body, 128<<20))
	tmp.Close()
	if err != nil {
		return fmt.Errorf("写入临时文件失败：%w", err)
	}
	if written < 1024*1024 {
		return fmt.Errorf("下载到的文件只有 %d 字节，太小，不像是可执行文件", written)
	}
	if err := os.Chmod(tmpPath, 0o755); err != nil {
		return err
	}

	// ⚠️ 必须先验证新二进制能跑，再替换当前这个。
	// 顺序反了的话，一次失败的升级会留下一个跑不起来的 agent，
	// 而用户已经在目标机上——那比「升级失败」糟糕得多。
	newVersion, err := probeBinaryVersion(tmpPath)
	if err != nil {
		return fmt.Errorf("新下载的文件跑不起来：%w（保持现有版本不变）", err)
	}
	if newVersion == current {
		fmt.Printf("已经是最新版本 %s，无需升级。\n", current)
		return nil
	}
	fmt.Printf("发现新版本 %s\n", newVersion)

	self, err := os.Executable()
	if err != nil {
		return fmt.Errorf("找不到自己所在的位置：%w", err)
	}
	self, _ = filepath.EvalSymlinks(self)

	// 备份：替换失败时能立刻回去。权限 0755，systemd 以 root 跑，
	// 属主跟着当前进程。
	backup := self + ".bak"
	if err := copyFile(self, backup); err != nil {
		return fmt.Errorf("备份现有二进制失败：%w", err)
	}
	rollback := func() {
		if err := copyFile(backup, self); err != nil {
			fmt.Fprintf(os.Stderr, "回滚也失败了：%v\n", err)
			fmt.Fprintf(os.Stderr, "原二进制仍在 %s，可手动复制回去。\n", backup)
			return
		}
		fmt.Fprintf(os.Stderr, "已回滚到 %s。\n", current)
	}

	// rename 是原子的：不会出现「目标路径上是个写了一半的文件」。
	if err := os.Rename(tmpPath, self); err != nil {
		// 最可能的原因是 self 所在文件系统与临时目录不同（跨设备）。
		// 那就退回「复制 + rename」在同一文件系统内完成。
		if err2 := copyFile(tmpPath, self); err2 != nil {
			return fmt.Errorf("替换二进制失败：%v / %v", err, err2)
		}
	}

	// 替换后再验一次：确认落地的那个真的能跑。
	if v, err := probeBinaryVersion(self); err != nil || v != newVersion {
		rollback()
		return fmt.Errorf("替换后的新版本自检未通过（%v），已回滚", err)
	}

	os.Remove(backup)
	fmt.Printf("已升级到 %s。\n", newVersion)
	fmt.Println("配置与凭据未改动（在 " + configDir + "）。")
	// 替换文件只是把新的放在那里，**还在跑的仍是旧进程**——不重启等于没升级。
	if err := restartAgentService(); err != nil {
		fmt.Printf("⚠️ 未能自动重启（%v）。\n", err)
		fmt.Println("   新版本要重启后才生效：")
		fmt.Println("     sudo systemctl restart nav-agent    # systemd 服务")
		fmt.Println("     sudo pkill -x nav-agent             # 手动运行的：停掉后按原样再起")
	} else {
		fmt.Println("已重启 nav-agent 服务，新版本即刻生效。")
	}
	return nil
}

// restartAgentService 让刚落地的二进制真正跑起来。
//
// ⚠️ 只替换文件是不够的：agentVersion() 是构建时用 -ldflags 注入的**常量**，
// 正在运行的那个进程会一直自报旧版本。而后台正是拿 /health 的 agentVersion
// 提示「可升级」——用户升级完仍看到同一个提示，只有重启才会消失。
// 实测踩过：主机侧 `nav-agent version` 已经是新版，后台却还在催升级，
// 用户按升级命令做完、主机侧也确认了版本，界面却毫无变化。
//
// 这不是新问题，只是升级这条路漏了 install.sh 早就做对的那一步：
// 部署是「停旧 → 装新 → 注册 → restart」，升级只做了中间的「装新」，
// 并且此前仅**打印**一句「重启后生效」——本仓库反复记录过
// 「只 warn 不做事」等于静默失败，这里是同一形状。
//
// 不预设「这台机器一定有 systemd」：直接试，失败就把手动命令交给用户，
// 而不是笼统地说「重启后生效」（他还得自己猜该重启什么）。
func restartAgentService() error {
	if _, err := exec.LookPath("systemctl"); err != nil {
		return errors.New("这台机器上没有 systemctl")
	}
	if out, err := exec.Command("systemctl", "restart", "nav-agent").CombinedOutput(); err != nil {
		msg := strings.TrimSpace(string(out))
		if msg == "" {
			msg = err.Error()
		}
		return errors.New(msg)
	}
	// 起来了不等于能用——systemd 对「启动即退出」照样返回 0（install.sh 的同一课）。
	time.Sleep(2 * time.Second)
	if err := exec.Command("systemctl", "is-active", "--quiet", "nav-agent").Run(); err != nil {
		return errors.New("重启后服务没有保持运行，请查 journalctl -u nav-agent")
	}
	return nil
}

// upgradeHTTPClient 是 enrollClient 的别名 —— 两者需要的 CA 逻辑完全相同，
// 早先各写一份 23 行，而 upgrade 那份**丢掉了 enroll 的两条 stderr 提示**：
// CA 路径写错时它静默回落到系统根池，用户看到的是一句
// 「certificate signed by unknown authority」，完全指不到「你的 --server-ca 路径不对」。
//
// 不按调用点拆开，而是共用一份并让提示只出现一次：拆开等于让两份副本漂移，
// 这正是本项目反复吃过亏的地方（协议常量、轮询白名单、架构白名单）。
func upgradeHTTPClient(args options) *http.Client { return enrollClient(args) }

// currentArch 返回本机对应的产物架构名（amd64 / arm64 / armv7）。
//
// ⚠️ `GOARCH=arm` 实际可能是 armv5/v6/v7，而本项目只发 armv7 的产物。
// 这里**一律按 armv7 走**，不按 GOARM 分支——
//
//	· 早先写的是 `if os.Getenv("GOARM") == "7" { return "armv7" }` 之后
//	  再 `return "armv7"`：**两个分支返回同值**，是一段死代码。
//	· 而且 `GOARM` 是**编译期**变量，运行中的二进制不带它——读它永远
//	  得到空串，所以那个 `if` 永远不成立。
//
// 统一按 v7 是安全的一侧：v7 的二进制能在 v6/v5 上运行，反过来不行。
// 真要区分 v5/v6 需要读 CPU 型号或 /proc/cpuinfo，那是另一种复杂度，
// 而本项目不支持那些机器。
func currentArch() (string, error) {
	switch runtime.GOARCH {
	case "amd64":
		return "amd64", nil
	case "arm64":
		return "arm64", nil
	case "arm":
		return "armv7", nil
	default:
		return "", fmt.Errorf("暂不支持的架构 %s（本服务提供 amd64 / arm64 / armv7）", runtime.GOARCH)
	}
}

// probeBinaryVersion 执行一个二进制问它版本，拿不到就说明它跑不起来。
//
// ⚠️ 必须用 `version --raw`：那个入口只输出版本号本身，
// 不带人类可读那行的括号与中文分隔符。早先这里解析的是普通输出，
// 实测拿到的是 "1.6.7（协议" —— 一个被当成版本号去比较的垃圾值。
// 机器可读的字段就该有一个只输出它的入口，而不是让脚本去解析给人看的那行。
func probeBinaryVersion(path string) (string, error) {
	out, err := exec.Command(path, "version", "--raw").CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("%v：%s", err, firstLine(out))
	}
	v := strings.TrimSpace(firstLine(out))
	if v == "" {
		return "", fmt.Errorf("没有输出版本号")
	}
	// 校验：这是从另一个可执行文件的输出里取的值，要拿去比较版本、
	// 可能被写进日志。格式不对就拒绝，而不是让任意字符串流过去。
	if v == "dev" {
		return v, nil
	}
	for _, r := range v {
		if (r < '0' || r > '9') && r != '.' {
			return "", fmt.Errorf("版本号格式异常：%q", v)
		}
	}
	return v, nil
}

// copyFile 复制文件并保留权限位。升级与回滚都靠它。
func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	info, err := in.Stat()
	if err != nil {
		return err
	}
	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, info.Mode().Perm())
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	// 写完再 chmod：OpenFile 的 mode 会被 umask 改掉
	if err := out.Chmod(info.Mode().Perm()); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}

func probeTCP(addr string, timeout time.Duration) probeState {
	conn, err := net.DialTimeout("tcp", addr, timeout)
	if err == nil {
		_ = conn.Close()
		return probeOpen
	}
	var nerr net.Error
	if errors.As(err, &nerr) && nerr.Timeout() {
		return probeTimeout
	}
	var opErr *net.OpError
	if errors.As(err, &opErr) && opErr.Err != nil {
		s := opErr.Err.Error()
		if strings.Contains(s, "connection refused") || strings.Contains(s, "refused") {
			return probeRefused
		}
	}
	if strings.Contains(err.Error(), "refused") {
		return probeRefused
	}
	return probeError
}

// ========== 小工具 ==========

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func sysHostname() string {
	h, err := os.Hostname()
	if err != nil {
		return "unknown"
	}
	return h
}

func readLoadAvg() (float64, float64) {
	raw, err := os.ReadFile("/proc/loadavg")
	if err != nil {
		return 0, 0
	}
	f := strings.Fields(string(raw))
	if len(f) < 2 {
		return 0, 0
	}
	a, _ := strconv.ParseFloat(f[0], 64)
	b, _ := strconv.ParseFloat(f[1], 64)
	return a, b
}

func sysUptime() float64 {
	raw, err := os.ReadFile("/proc/uptime")
	if err != nil {
		return 0
	}
	f := strings.Fields(string(raw))
	if len(f) < 1 {
		return 0
	}
	v, _ := strconv.ParseFloat(f[0], 64)
	return v
}

func max(a, b float64) float64 {
	if a > b {
		return a
	}
	return b
}

func min(a, b float64) float64 {
	if a < b {
		return a
	}
	return b
}
