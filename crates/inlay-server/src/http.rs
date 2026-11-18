//! The little of HTTP/1.1 this server needs, over the standard library:
//! one request on a connection, its body by `Content-Length`, one answer,
//! and the connection closed.
//!
//! Written here and not taken from a library so that what a client sends
//! can never decide how much the server allocates or how long it waits:
//! the request's head has a size, the body is read only up to the limit of
//! its route, and every read and write gives up after `PATIENCE`.

use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::{Shutdown, TcpStream};
use std::time::Duration;

/// The most a request line and its headers may come to.
const MAX_HEAD: usize = 64 * 1024;
/// How long a client may leave a read or a write waiting.
const PATIENCE: Duration = Duration::from_secs(30);

/// A request without its body.
pub struct Head {
    /// In capitals.
    pub method: String,
    /// The path and query, starting with `/`.
    pub target: String,
    /// Names in lower case.
    pub headers: Vec<(String, String)>,
}

impl Head {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(n, _)| n == name)
            .map(|(_, v)| v.as_str())
    }
}

/// Why a request is not answered as asked.
pub enum Refused {
    /// Nothing came, or the client went away: there is nobody to answer.
    Gone,
    /// The status and the reason to answer with.
    Status(u16, &'static str),
}

pub struct Connection {
    reader: BufReader<TcpStream>,
}

impl Connection {
    pub fn new(stream: TcpStream) -> io::Result<Connection> {
        stream.set_read_timeout(Some(PATIENCE))?;
        stream.set_write_timeout(Some(PATIENCE))?;
        Ok(Connection {
            reader: BufReader::new(stream),
        })
    }

    pub fn head(&mut self) -> Result<Head, Refused> {
        let mut lines: Vec<String> = Vec::new();
        let mut left = MAX_HEAD;
        loop {
            let mut line = Vec::new();
            let read = (&mut self.reader)
                .take(left as u64 + 1)
                .read_until(b'\n', &mut line)
                .map_err(|_| Refused::Gone)?;
            if read > left {
                return Err(Refused::Status(431, "The request's headers are too long."));
            }
            if !line.ends_with(b"\n") {
                return Err(Refused::Gone);
            }
            left -= read;
            let line = String::from_utf8(line)
                .map_err(|_| Refused::Status(400, "The request's headers are not UTF-8."))?;
            let line = line.trim_end_matches(['\r', '\n']);
            if !line.is_empty() {
                lines.push(line.to_string());
            } else if !lines.is_empty() {
                break;
            }
        }
        parse_head(&lines).map_err(|why| Refused::Status(400, why))
    }

    /// The request's body, of `limit` bytes at most.
    pub fn body(&mut self, head: &Head, limit: usize) -> Result<Vec<u8>, Refused> {
        if head.header("transfer-encoding").is_some() {
            return Err(Refused::Status(
                411,
                "Send the body with a Content-Length, not in chunks.",
            ));
        }
        let length = match head.header("content-length") {
            None => 0,
            Some(length) if !length.is_empty() && length.bytes().all(|b| b.is_ascii_digit()) => {
                // More digits than a number holds is too large all the same.
                length.parse::<usize>().unwrap_or(usize::MAX)
            }
            Some(_) => return Err(Refused::Status(400, "Content-Length is not a number.")),
        };
        if length > limit {
            return Err(Refused::Status(413, "The body is too large."));
        }
        if length > 0
            && head
                .header("expect")
                .is_some_and(|e| e.eq_ignore_ascii_case("100-continue"))
        {
            let stream = self.reader.get_mut();
            stream
                .write_all(b"HTTP/1.1 100 Continue\r\n\r\n")
                .and_then(|()| stream.flush())
                .map_err(|_| Refused::Gone)?;
        }
        let mut body = vec![0; length];
        self.reader
            .read_exact(&mut body)
            .map_err(|_| Refused::Gone)?;
        Ok(body)
    }

    /// Answers and closes. `bare` is for a `HEAD`: the headers of the
    /// answer without its body.
    pub fn respond(mut self, status: u16, headers: &[(&str, &str)], body: &[u8], bare: bool) {
        let mut head = format!("HTTP/1.1 {status} {}\r\n", reason(status));
        for (name, value) in headers {
            // A value with a line break in it would be a header of its own.
            if !value.contains(['\r', '\n']) {
                head.push_str(&format!("{name}: {value}\r\n"));
            }
        }
        head.push_str(&format!(
            "Content-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        ));
        let stream = self.reader.get_mut();
        let sent = stream
            .write_all(head.as_bytes())
            .and_then(|()| if bare { Ok(()) } else { stream.write_all(body) })
            .and_then(|()| stream.flush());
        if sent.is_err() {
            return;
        }
        // What the client was still sending is let run out for a moment, so
        // that closing does not cut off the answer it has yet to read.
        let _ = stream.shutdown(Shutdown::Write);
        let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));
        let _ = io::copy(&mut (&mut self.reader).take(1 << 20), &mut io::sink());
    }
}

fn parse_head(lines: &[String]) -> Result<Head, &'static str> {
    let mut first = lines[0].split(' ');
    let (Some(method), Some(target), Some(version), None) =
        (first.next(), first.next(), first.next(), first.next())
    else {
        return Err("The request line is not METHOD /path HTTP/1.1.");
    };
    if !version.starts_with("HTTP/1.") {
        return Err("Only HTTP/1.0 and HTTP/1.1 are spoken here.");
    }
    if method.is_empty() || !method.bytes().all(|b| b.is_ascii_alphabetic()) {
        return Err("The method is not a word.");
    }
    // A proxy may name the whole address; the path is what is asked for.
    let target = match target
        .strip_prefix("http://")
        .or_else(|| target.strip_prefix("https://"))
    {
        Some(rest) => rest.find('/').map_or("/", |at| &rest[at..]),
        None => target,
    };
    if !target.starts_with('/') || target.chars().any(char::is_control) {
        return Err("The request's path must start with /.");
    }
    let mut headers: Vec<(String, String)> = Vec::new();
    for line in &lines[1..] {
        let Some((name, value)) = line.split_once(':') else {
            return Err("A header has no colon.");
        };
        if name.is_empty() || name.contains(char::is_whitespace) {
            return Err("A header's name has a space in it.");
        }
        let name = name.to_ascii_lowercase();
        // Two lengths, or two hosts, are two readings of one request.
        if (name == "content-length" || name == "host") && headers.iter().any(|(n, _)| *n == name) {
            return Err("Content-Length and Host may be given once.");
        }
        headers.push((name, value.trim().to_string()));
    }
    Ok(Head {
        method: method.to_ascii_uppercase(),
        target: target.to_string(),
        headers,
    })
}

fn reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        304 => "Not Modified",
        400 => "Bad Request",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        409 => "Conflict",
        411 => "Length Required",
        413 => "Content Too Large",
        415 => "Unsupported Media Type",
        422 => "Unprocessable Content",
        431 => "Request Header Fields Too Large",
        500 => "Internal Server Error",
        503 => "Service Unavailable",
        _ => "Status",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    /// What the server makes of `sent`: the request's method, target and
    /// body back as the answer's body, or the status it was refused with.
    fn exchange(sent: &[u8], limit: usize) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let mut connection = Connection::new(listener.accept().unwrap().0).unwrap();
            let read = connection
                .head()
                .and_then(|head| connection.body(&head, limit).map(|body| (head, body)));
            match read {
                Ok((head, body)) => {
                    let text = format!(
                        "{} {} {}",
                        head.method,
                        head.target,
                        String::from_utf8_lossy(&body)
                    );
                    connection.respond(200, &[("X-Test", "1")], text.as_bytes(), false)
                }
                Err(Refused::Status(status, why)) => {
                    connection.respond(status, &[], why.as_bytes(), false)
                }
                Err(Refused::Gone) => {}
            }
        });
        let mut client = TcpStream::connect(address).unwrap();
        client.write_all(sent).unwrap();
        client.shutdown(Shutdown::Write).unwrap();
        let mut answer = String::new();
        client.read_to_string(&mut answer).unwrap();
        server.join().unwrap();
        answer
    }

    #[test]
    fn a_request_is_read_and_answered() {
        let answer = exchange(
            b"post /api/tools?q=a HTTP/1.1\r\nHost: localhost\r\nContent-Length: 2\r\n\r\n{}",
            10,
        );
        assert!(answer.starts_with("HTTP/1.1 200 OK\r\n"), "{answer}");
        assert!(answer.contains("X-Test: 1\r\n"));
        assert!(answer.contains("Connection: close\r\n"));
        assert!(
            answer.ends_with("\r\n\r\nPOST /api/tools?q=a {}"),
            "{answer}"
        );
        let answer = exchange(b"GET http://localhost:8000/a/b HTTP/1.1\r\n\r\n", 10);
        assert!(answer.ends_with("GET /a/b "), "{answer}");
    }

    #[test]
    fn a_length_is_only_a_claim_until_it_is_under_the_limit() {
        for length in ["11", "99999999999", "99999999999999999999999999"] {
            let sent = format!("PUT / HTTP/1.1\r\nContent-Length: {length}\r\n\r\n");
            let answer = exchange(sent.as_bytes(), 10);
            assert!(answer.starts_with("HTTP/1.1 413 "), "{length}: {answer}");
        }
        for length in ["-1", "1e3", "", "0x10"] {
            let sent = format!("PUT / HTTP/1.1\r\nContent-Length: {length}\r\n\r\n");
            assert!(exchange(sent.as_bytes(), 10).starts_with("HTTP/1.1 400 "));
        }
        // Shorter than it said, and gone: nothing to answer.
        assert_eq!(
            exchange(b"PUT / HTTP/1.1\r\nContent-Length: 5\r\n\r\nab", 10),
            ""
        );
    }

    #[test]
    fn what_is_not_a_plain_request_is_refused() {
        let status = |sent: &[u8]| exchange(sent, 10)[..12].to_string();
        assert_eq!(status(b"GET /\r\n\r\n"), "HTTP/1.1 400");
        assert_eq!(status(b"GET / HTTP/2\r\n\r\n"), "HTTP/1.1 400");
        assert_eq!(status(b"G\x1bT / HTTP/1.1\r\n\r\n"), "HTTP/1.1 400");
        assert_eq!(status(b"GET nothing HTTP/1.1\r\n\r\n"), "HTTP/1.1 400");
        assert_eq!(
            status(b"GET / HTTP/1.1\r\nno colon\r\n\r\n"),
            "HTTP/1.1 400"
        );
        assert_eq!(
            status(b"GET / HTTP/1.1\r\nHost: a\r\nHost: localhost\r\n\r\n"),
            "HTTP/1.1 400"
        );
        assert_eq!(
            status(b"PUT / HTTP/1.1\r\nContent-Length: 1\r\nContent-Length: 2\r\n\r\nab"),
            "HTTP/1.1 400"
        );
        assert_eq!(
            status(b"PUT / HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n"),
            "HTTP/1.1 411"
        );
        let mut long = b"GET / HTTP/1.1\r\nX: ".to_vec();
        long.resize(MAX_HEAD + 100, b'a');
        assert_eq!(status(&long), "HTTP/1.1 431");
    }
}
