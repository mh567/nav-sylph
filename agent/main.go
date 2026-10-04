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

// VERSION 必须与服务端 server.js 的 AGENT_PROTOCOL_VERSION 一致。
// 不一致时服务端会明确报错，而不是把不认识的字段当成 0 读进去
// （那样会显示「CPU 0%」这种错误结论）。
const VERSION = 1

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
	case "version", "--version", "-v":
		fmt.Printf("nav-agent v%d (%s/%s, %s)\n", VERSION, runtime.GOOS, runtime.GOARCH, runtime.Version())
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
  nav-agent version      版本

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
	Load1         float64  `json:"load1"`
	Load5         float64  `json:"load5"`
	Uptime        float64  `json:"uptime"`
	Cores         int      `json:"cores"`
	Hostname      string   `json:"hostname"`
	Platform      string   `json:"platform"`
	SampledAt     int64    `json:"sampledAt"`
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

	m := &metrics{
		Version:     VERSION,
		CPU:         cpu,
		MemoryUsed:  mem.Used,
		MemoryTotal: mem.Total,
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
	caPath := args.str("server-ca", "NAV_AGENT_SERVER_CA")
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
		payload := map[string]any{"status": "ok", "version": VERSION}
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
	fmt.Printf("Nav Sylph agent v%d\n", VERSION)
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

	fmt.Printf("Nav Sylph agent v%d\n", VERSION)
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
	fmt.Printf("nav-agent v%d\n", VERSION)
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
