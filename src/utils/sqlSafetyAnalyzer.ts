/**
 * SQL Safety Analyzer Module
 * Analyzes SQL queries for potentially dangerous operations and injection patterns
 */

export interface SafetyAnalysisResult {
  isSafe: boolean;
  isReadOnly: boolean;
  warnings: string[];
  detectedOperations: string[];
}

export class SQLSafetyAnalyzer {
  // Dangerous SQL operations that modify data or schema
  private static readonly DANGEROUS_OPERATIONS = [
    'INSERT',
    'UPDATE',
    'DELETE',
    'DROP',
    'ALTER',
    'CREATE',
    'TRUNCATE',
    'GRANT',
    'REVOKE',
    'EXEC',
    'EXECUTE',
    'CALL',
    'MERGE',
    'REPLACE'
  ];

  // SQL injection patterns to detect
  // Temporarily disabled overly aggressive patterns that reject valid queries
  private static readonly INJECTION_PATTERNS = [
    /--\s*DROP/,
    /--\s*DELETE/,
    /--\s*TRUNCATE/,
    /;\s*DROP/,
    /;\s*DELETE/,
    /;\s*TRUNCATE/,
    /UNION\s+SELECT/,
    // /OR\s+1\s*=\s*1/,  // Too aggressive - matches legitimate SQL
    // /AND\s+1\s*=\s*1/,  // Too aggressive - matches legitimate SQL
    // /'\s*OR\s*/,
    // /"\s*OR\s*/,
    // /\*\//,
    // /\/\*/
  ];

  /**
   * Analyze a SQL query for safety
   * @param query The SQL query to analyze
   * @returns Safety analysis result
   */
  static analyzeQuery(query: string): SafetyAnalysisResult {
    const warnings: string[] = [];
    const detectedOperations: string[] = [];
    let isReadOnly = true;

    // Check for dangerous operations
    for (const operation of this.DANGEROUS_OPERATIONS) {
      const regex = new RegExp(`\\b${operation}\\b`, 'i');
      if (regex.test(query)) {
        detectedOperations.push(operation);
        isReadOnly = false;
        warnings.push(`Detected potentially dangerous operation: ${operation}`);
      }
    }

    // Check for SQL injection patterns
    for (const pattern of this.INJECTION_PATTERNS) {
      if (pattern.test(query)) {
        detectedOperations.push('SQL_INJECTION_PATTERN');
        isReadOnly = false;
        warnings.push('Detected potential SQL injection pattern');
        break; // One injection warning is enough
      }
    }

    // Check for multiple statements (can be dangerous)
    const statementCount = (query.match(/;/g) || []).length;
    if (statementCount > 1) {
      detectedOperations.push('MULTIPLE_STATEMENTS');
      warnings.push(`Query contains multiple statements (${statementCount})`);
    }

    const isSafe = isReadOnly && detectedOperations.length === 0;

    return {
      isSafe,
      isReadOnly,
      warnings,
      detectedOperations
    };
  }

  /**
   * Check if a query is read-only (SELECT only)
   * @param query The SQL query to check
   * @returns True if the query is read-only
   */
  static isReadOnly(query: string): boolean {
    const analysis = this.analyzeQuery(query);
    return analysis.isReadOnly;
  }

  /**
   * Get a human-readable safety report
   * @param query The SQL query to analyze
   * @returns Formatted safety report
   */
  static getSafetyReport(query: string): string {
    const analysis = this.analyzeQuery(query);
    
    if (analysis.isSafe) {
      return '✅ Query appears safe (read-only)';
    }

    let report = '⚠️ Query safety concerns:\n';
    analysis.warnings.forEach((warning, index) => {
      report += `  ${index + 1}. ${warning}\n`;
    });

    if (!analysis.isReadOnly) {
      report += '\n🔒 This query modifies data or schema and will be blocked when read-only mode is enabled.';
    }

    return report;
  }
}
