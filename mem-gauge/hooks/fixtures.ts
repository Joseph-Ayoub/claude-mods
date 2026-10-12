// Command outputs captured on a 128 GB, 18-core Mac (Darwin 25.4), trimmed.
// Shared by the pure tests and the kit tests that feed them through process.run.

export const SYSCTL = `hw.memsize: 137438953472
hw.ncpu: 18
kern.memorystatus_level: 93
vm.swapusage: total = 1024.00M  used = 202.00M  free = 822.00M  (encrypted)
vm.loadavg: { 47.83 64.42 58.25 }
`

export const VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                             2383985.
Pages active:                           2710467.
Pages inactive:                         2425814.
Pages speculative:                       283578.
Pages throttled:                              0.
Pages wired down:                        421427.
Pages purgeable:                         130101.
"Translation faults":                2031253795.
Pages copy-on-write:                  182823924.
File-backed pages:                      1528265.
Anonymous pages:                        3891594.
Pages stored in compressor:              208292.
Pages occupied by compressor:             79175.
Swapins:                                1282974.
`

export const DF = `Filesystem     1024-blocks      Used Available Capacity iused      ifree %iused  Mounted on
/dev/disk3s1s1  1948404040  12261568 972318656     2%  458115 4294172073    0%   /
`

/** `df -kP`: the APFS system and data volumes, the helpers, an external disk with a space in its name, a simulator runtime. */
export const DF_ALL = `Filesystem     1024-blocks       Used Available Capacity  Mounted on
/dev/disk3s1s1  1948404040   12261568 972318656     2%    /
devfs                  212        212         0   100%    /dev
/dev/disk3s6    1948404040   26214432 972318656     3%    /System/Volumes/VM
/dev/disk3s2    1948404040    7542452 972318656     1%    /System/Volumes/Preboot
/dev/disk3s5    1948404040  976085384 972318656    51%    /System/Volumes/Data
map auto_home            0          0         0   100%    /System/Volumes/Data/home
/dev/disk7s2    1953514584 1465136640 488377944    75%    /Volumes/Backup Disk
/dev/disk5s1      17147904   16623700    480032    98%    /Library/Developer/CoreSimulator/Volumes/iOS_21F79
`

/** `du -sk <path>` answers by path suffix, in KB; a missing entry stands for a folder du could not read in time. */
export const DU_KB: Record<string, number> = {
  '.claude/projects': 3355443,
  '.claude/file-history': 512000,
  'Library/Developer/Xcode/DerivedData': 20971520,
  'Library/Developer/CoreSimulator/Devices': 41943040,
  '.Trash': 0,
}

const ENGINE = '/Users/tester/Library/Application Support/Claude/claude-code/2.1.293/x/claude.app/Contents/MacOS/claude'
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const RENDERER =
  '/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Versions/1/Helpers/Google Chrome Helper (Renderer).app/Contents/MacOS/Google Chrome Helper (Renderer)'

/**
 * This session's engine is 100 (an MCP server 101 and a shell 102 under it,
 * a grandchild 103 under the shell); another session's engine is 200 with an
 * MCP server 201. Chrome and its renderer roll up into one app.
 */
export const PS = `    1     0   20000 /sbin/launchd
   99     1    2048 /bin/zsh
  100    99  1048576 ${ENGINE}
  101   100   102400 /opt/homebrew/bin/node
  102   100    10240 /bin/zsh
  103   102   51200 /usr/bin/python3
  200     1  524288 ${ENGINE}
  201   200   20480 /opt/homebrew/bin/bun
  300     1  2097152 ${CHROME}
  301   300  1048576 ${RENDERER}
  400     1   65536 /Applications/Slack.app/Contents/MacOS/Slack
`
