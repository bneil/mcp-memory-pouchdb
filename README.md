# Memory Custom

This project adds new features to the Memory server offered by the MCP team. It allows for the creation and management of a knowledge graph that captures interactions via a language model (LLM).

## New Features

### 1. Custom Memory Paths

- Users can now specify different memory file paths for various projects.
- **Why?**: This feature enhances organization and management of memory data, allowing for project-specific memory storage.

### 2. Timestamping

- The server now generates timestamps for interactions.
- **Why?**: Timestamps enable tracking of when each memory was created or modified, providing better context and history for the stored data.

## Getting Started

### Prerequisites

- Node.js (version 16 or higher)

### Installation

1. Clone the repository:

   ```bash
   git clone git@github.com:BRO3886/mcp-memory-custom.git
   cd mcp-memory-custom
   ```

2. Install the dependencies:

   ```bash
   npm install
   ```

### Configuration

Before running the server, you can set the `MEMORY_FILE_PATH` environment variable to specify the path for the memory file. If not set, the server will default to using `memory.json` in the same directory as the script.

### Running the Server

To start the Knowledge Graph Memory Server, run:

```bash
npm run build
node dist/index.js
```

The server will listen for requests via standard input/output.

## API Endpoints

The server exposes several tools that can be called with specific parameters:

- **Get Current Time**
- **Set Memory File Path**
- **Create Entities**
- **Create Relations**
- **Add Observations**
- **Delete Entities**
- **Delete Observations**
- **Delete Relations**
- **Read Graph**
- **Search Nodes**
- **Open Nodes**

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.

## Acknowledgments

- Inspired by the Memory server from Anthropic.
- Thanks to the contributors and the open-source community for their support.
