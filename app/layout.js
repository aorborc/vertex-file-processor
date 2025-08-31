export const metadata = {
  title: "Vertex File Processor",
  description: "Upload a PDF URL and prompt, process via Vertex AI"
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: 'system-ui, sans-serif', margin: 24 }}>{children}</body>
    </html>
  );
}

