# README.md

# RunContainer

RunContainer is a Windows-based container management application that allows users to install, run, and manage applications in a sandboxed environment. This project is designed to provide a seamless experience for managing applications without affecting the host system.

## Features

- **File Explorer Integration**: Open a file explorer to select an executable (EXE) file for installation.
- **Container Installation**: Install selected applications in a sandboxed environment.
- **Container Management**: View installed applications with their icons and names, and manage their lifecycle.
- **Sandbox Execution**: Run applications in a secure sandbox, with the ability to terminate them easily.
- **State Management**: Efficiently manage the state of containers using custom hooks.
- **Responsive Design**: Styled components for a user-friendly interface.

## Project Structure

```
runcontainer
├── public
│   └── index.html
├── src
│   ├── App.jsx
│   ├── main.jsx
│   ├── components
│   │   └── ContainerManager.jsx
│   ├── hooks
│   │   └── useContainers.js
│   ├── services
│   │   └── containerService.js
│   ├── styles
│   │   └── index.css
│   └── utils
│       └── index.js
├── package.json
└── README.md
```

## Installation

1. Clone the repository:
   ```
   git clone <repository-url>
   cd runcontainer
   ```

2. Install dependencies:
   ```
   npm install
   ```

3. Start the application:
   ```
   npm start
   ```

## Usage

1. Launch the application.
2. Click on the "Install EXE" option to open the file explorer.
3. Select the desired EXE file to install it in a sandbox.
4. The installed application will appear in the container list.
5. Click "Run" to execute the application in a sandboxed environment.
6. To return to the Container Manager, simply terminate the running application.

## Contributing

Contributions are welcome! Please feel free to submit a pull request or open an issue for any enhancements or bug fixes.

## License

This project is licensed under the MIT License. See the LICENSE file for details.