import http.server
import socketserver
import webbrowser
import os

PORT = 8081
DIRECTORY = os.path.dirname(os.path.abspath(__file__))
os.chdir(DIRECTORY)

Handler = http.server.SimpleHTTPRequestHandler

with socketserver.TCPServer(("", PORT), Handler) as httpd:
    print(f"[{DIRECTORY}] Server is running!")
    print(f"Please open your browser and go to: http://localhost:{PORT}/")
    webbrowser.open(f"http://localhost:{PORT}/")
    httpd.serve_forever()
