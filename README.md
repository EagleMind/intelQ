# IntelQuery

A powerful database query tool with AI-powered natural language SQL generation. Built with Tauri, React, and TypeScript for cross-platform desktop applications.

## Features

### 🤖 AI-Powered SQL Generation
- **Natural Language to SQL**: Convert plain English queries into SQL using advanced AI models
- **Multiple AI Providers**: Support for LM Studio (local) and OpenRouter (cloud) APIs
- **Provider Switching**: Easy switching between AI providers with validation

### 🔒 Database Protection
- **Read-Only Mode**: Toggle protection to prevent data modification operations
- **SQL Safety Analysis**: Automatic detection of dangerous SQL operations
- **Injection Prevention**: Built-in SQL injection pattern detection
- **Query Validation**: Real-time analysis before execution

### 🗄️ Database Management
- **Multiple Database Support**: MySQL, PostgreSQL, and SQLite
- **Connection Management**: Save and manage multiple database connections
- **Data Explorer**: Browse tables, view data, and export results
- **Schema Inspection**: View database schemas and table structures
- **Query Execution**: Run SQL queries with result display

## Tech Stack

- **Frontend**: React 19, TypeScript, Vite 7
- **Backend**: Rust with Tauri 2
- **Styling**: Tailwind CSS 4
- **Database**: SQLx (MySQL, PostgreSQL, SQLite)
- **Icons**: Lucide React
- **AI Integration**: LM Studio API, OpenRouter API

## Installation

### Prerequisites
- Node.js 18+ and npm
- Rust and Cargo
- Tauri CLI

### Development Setup

1. Clone the repository:
```bash
git clone <repository-url>
cd intelquery
```

2. Install dependencies:
```bash
npm install
```

3. Run development server:
```bash
npm run tauri dev
```

## Configuration

### AI Provider Setup

#### LM Studio (Local)
1. Start LM Studio and load a model
2. Default endpoint: `http://localhost:1234/api/v1/chat`
3. Configure in Settings (gear icon in NLQ section)

#### OpenRouter (Cloud)
1. Get API key from [OpenRouter](https://openrouter.ai)
2. Default API key is pre-configured
3. Configure in Settings (gear icon in NLQ section)

### Database Connections

1. Click "Manage Connections" in the header
2. Add new connection with database details:
   - Database type (MySQL, PostgreSQL, SQLite)
   - Host and port
   - Database name
   - Username and password
3. Save and select connection

## Usage

### Natural Language Queries

1. Connect to a database
2. Enter your query in natural language (e.g., "Show me all users from the US")
3. Click "Generate SQL" to convert to SQL
4. Review the generated SQL query
5. Click "Execute" to run the query
6. View results in the results panel

### Table Tagging
Use `@table` syntax to focus on specific tables:
- "Show @users from New York"
- "Count @orders by @customers"

### Read-Only Protection
- Toggle "Read-Only" mode in the NLQ header
- When enabled, blocks INSERT, UPDATE, DELETE, and other modification operations
- Provides detailed safety reports for blocked queries

### Data Explorer
1. Browse available tables in the left panel
2. Click a table to view its data
3. Use pagination for large datasets
4. Export results to CSV

## Building

### Build for Windows

```bash
npm run tauri build
```

The built EXE file will be located at:
`src-tauri/target/release/intelquery_0.1.0_x64-setup.exe`

### Build Requirements
- Windows 10 or later
- Visual Studio Build Tools
- Rust toolchain
- At least 2-3 GB free disk space

## Development

### Project Structure
```
intelquery/
├── src/                  # React frontend
│   ├── components/       # React components
│   │   ├── DataExplorer.tsx
│   │   ├── NLQInterface.tsx
│   │   └── ConnectionsManager.tsx
│   ├── utils/           # Utility functions
│   │   ├── tauri.ts     # Tauri API wrapper
│   │   └── sqlSafetyAnalyzer.ts
│   └── App.tsx          # Main application
├── src-tauri/           # Rust backend
│   ├── src/
│   │   ├── lib.rs       # Database operations
│   │   └── main.rs      # Tauri entry point
│   └── tauri.conf.json  # Tauri configuration
└── package.json         # Node dependencies
```

### Key Files
- `src/components/NLQInterface.tsx`: Natural language query interface with AI integration
- `src/components/DataExplorer.tsx`: Data browsing and table management
- `src/utils/sqlSafetyAnalyzer.ts`: SQL safety analysis and validation
- `src-tauri/src/lib.rs`: Database connection and query execution logic

### Recommended IDE Setup
- [VS Code](https://code.visualstudio.com/)
- [Tauri Extension](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode)
- [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)

## Security Features

### SQL Safety Analysis
- Detects dangerous operations: INSERT, UPDATE, DELETE, DROP, ALTER, etc.
- Identifies SQL injection patterns
- Validates multiple statements
- Provides detailed safety reports

### Data Protection
- Read-only mode prevents accidental data modification
- Connection credentials stored securely
- No data sent to external servers (except AI API calls)

## License

This project is proprietary software.

## Support

For issues and feature requests, please contact the development team.

## Version History

### 0.1.0 (Current)
- Initial release
- AI-powered SQL generation
- Multi-database support
- Read-only protection mode
- Modern dark UI
- Connection management
