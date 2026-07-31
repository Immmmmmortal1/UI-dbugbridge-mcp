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

    private var entries: [LookDebugLogEntry] = []
    private var generation = 0

    func append(level: String, category: String, message: String) {
        let entry = LookDebugLogEntry(
            timestamp: ISO8601DateFormatter().string(from: Date()),
            level: level,
            category: category,
            message: message
        )
        entries.append(entry)
        generation += 1
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
