export const metadata = {
  title: "Vertex File Processor",
  description: "Upload a PDF URL and prompt, process via Vertex AI",
};

import "./globals.css";

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>
        <div className="container">
          <header className="header">
            <h1 className="brand">Vertex File Processor</h1>
            <nav className="nav"/>
          </header>
          {children}
        </div>
      </body>
    </html>
  );
}
