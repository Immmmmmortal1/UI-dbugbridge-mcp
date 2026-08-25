import Foundation

struct LookDebugLogEntry: Codable, Equatable {
    let timestamp: String
    let level: String
    let category: String
    let message: String
}
struct LookDebugLogsResponse: Codable, Equatable {
    let success: Bool
    let sessionID: String
    let status: String
    let lines: [LookDebugLogEntry]
    let error: String?
}

actor LookDebugLogStore {
    static let shared = LookDebugLogStore()

    /// ring buffer 上限 2000 条，超限丢弃最旧
    private static let maxEntries = 2000
    /// 单条 message 最大字符数，超限截断
    private static let maxMessageLength = 2000
    /// /debug/logs 默认返回最近条数
    static let defaultReadLimit = 200
    /// 需脱敏的敏感关键词（不区分大小写），用于键值对匹配
    private static let sensitiveKeys = ["password", "token", "authorization", "secret", "apikey", "api_key"]
    /// 预编译脱敏正则（大小写不敏感），覆盖以下形式：
    /// 1. key="带空格引号值" / key='带空格引号值'（整个引号值脱敏）
    /// 2. key: Bearer xxx / key=Bearer xxx（Bearer + token 整体脱敏）
    /// 3. key=value / key: value（值到空白/逗号/分号/行尾，无引号无 Bearer）
    /// 限制：不带键名的裸敏感文本（如纯 "Bearer xxx" 无 key 前缀）无法识别；
    ///       无引号且含空格的值（如 `password: my secret`）只能脱敏第一个单词。
    private static let redactRegex: NSRegularExpression? = {
        let keys = sensitiveKeys.joined(separator: "|")
        // group 1: key + 分隔符（password= / authorization: ）保留
        // group 2: value（引号串 / Bearer token / 普通值）替换为 <redacted>
        let pattern = "(\(keys))\\s*[:=]\\s*(\"[^\"]*\"|'[^']*'|Bearer\\s+\\S+|[^\\s,;\\}\\]]+)"
        return try? NSRegularExpression(pattern: pattern, options: .caseInsensitive)
    }()

    private var entries: [LookDebugLogEntry] = []
    private var generation = 0

    func append(level: String, category: String, message: String) {
        let processed = Self.redact(message: Self.truncate(message: message))
        let entry = LookDebugLogEntry(
            timestamp: ISO8601DateFormatter().string(from: Date()),
            level: level,
            category: category,
            message: processed
        )
        entries.append(entry)
        // ring buffer：超限丢弃最旧
        if entries.count > Self.maxEntries {
            entries.removeFirst(entries.count - Self.maxEntries)
        }
        generation += 1
    }

    /// 截断超长 message
    private static func truncate(message: String) -> String {
        guard message.count > maxMessageLength else { return message }
        let endIndex = message.index(message.startIndex, offsetBy: maxMessageLength)
        return String(message[..<endIndex]) + "…<truncated>"
    }

    /// 基础脱敏：匹配敏感键值对，替换 value 为 <redacted>，保留 key 与分隔符
    /// 覆盖示例：
    /// - `password="my secret"` → `password=<redacted>`
    /// - `authorization: Bearer very-secret` → `authorization: <redacted>`
    /// - `token=abc123` → `token=<redacted>`
    /// - `api_key: sk-xxx` → `api_key: <redacted>`
    private static func redact(message: String) -> String {
        guard let regex = redactRegex else { return message }
        let range = NSRange(message.startIndex..., in: message)
        // $1 = key+分隔符（保留），$2 = value（替换为 <redacted>）
        return regex.stringByReplacingMatches(
            in: message,
            options: [],
            range: range,
            withTemplate: "$1<redacted>"
        )
    }

    func read(query: String?, level: String?, category: String?, limit: Int) -> [LookDebugLogEntry] {
        matchingEntries(query: query, level: level, category: category, limit: limit)
    }

    func waitForNewEntries(
        query: String?,
        level: String?,
        category: String?,
        limit: Int,
        timeoutMs: Int
    ) async -> [LookDebugLogEntry] {
        let initialGeneration = generation
        let timeoutNs = UInt64(max(0, min(timeoutMs, 120_000))) * 1_000_000
        let startedAt = DispatchTime.now().uptimeNanoseconds

        while true {
            if generation > initialGeneration {
                let matches = matchingEntries(query: query, level: level, category: category, limit: limit)
                if !matches.isEmpty {
                    return matches
                }
            }

            let elapsed = DispatchTime.now().uptimeNanoseconds - startedAt
            if elapsed >= timeoutNs {
                return []
            }

            let remaining = timeoutNs - elapsed
            let sleepNs = min(remaining, 50_000_000)
            try? await Task.sleep(nanoseconds: sleepNs)
            if Task.isCancelled {
                return []
            }
        }
    }

    private func matchingEntries(query: String?, level: String?, category: String?, limit: Int) -> [LookDebugLogEntry] {
        let normalizedQuery = query?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let normalizedLevel = level?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let normalizedCategory = category?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()

        let matches = entries.filter { entry in
            let queryMatches = normalizedQuery.map { $0.isEmpty || entry.message.lowercased().contains($0) } ?? true
            let levelMatches = normalizedLevel.map { $0.isEmpty || entry.level.lowercased() == $0 } ?? true
            let categoryMatches = normalizedCategory.map { $0.isEmpty || entry.category.lowercased() == $0 } ?? true
            return queryMatches && levelMatches && categoryMatches
        }

        let boundedLimit = max(1, min(limit, 5_000))
        return matches.count > boundedLimit ? Array(matches.suffix(boundedLimit)) : matches
    }
}
