package main

import (
	"bytes"
	"crypto/x509"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/url"
	"os"
	"strings"
	"time"

	http "github.com/bogdanfinn/fhttp"
	tlsclient "github.com/bogdanfinn/tls-client"
	"github.com/bogdanfinn/tls-client/profiles"
	tls "github.com/bogdanfinn/utls"
)

const protocolVersion = 1
const profileName = "firefox_148"
const userAgent = "Mozilla/5.0 (X11; Linux x86_64; rv:148.0) Gecko/20100101 Firefox/148.0"

type request struct {
	Version   int         `json:"version"`
	URL       string      `json:"url"`
	Method    string      `json:"method"`
	Headers   [][2]string `json:"headers"`
	Body      []byte      `json:"body,omitempty"`
	Proxy     string      `json:"proxy,omitempty"`
	CA        string      `json:"ca,omitempty"`
	Insecure  bool        `json:"insecure"`
	TimeoutMS int         `json:"timeoutMs"`
}

type response struct {
	Version int                 `json:"version"`
	Status  int                 `json:"status,omitempty"`
	Headers map[string][]string `json:"headers,omitempty"`
	Error   string              `json:"error,omitempty"`
	Code    string              `json:"code,omitempty"`
}

func fetch(input request) (*http.Response, func(), error) {
	if input.Version != protocolVersion || input.TimeoutMS <= 0 {
		return nil, nil, errors.New("invalid helper protocol or timeout")
	}
	target, err := url.Parse(input.URL)
	if err != nil || (target.Scheme != "http" && target.Scheme != "https") || target.Host == "" || target.User != nil {
		return nil, nil, errors.New("invalid request URL")
	}
	transport := &tlsclient.TransportOptions{DisableCompression: true, MaxResponseHeaderBytes: 65536}
	if input.CA != "" {
		roots, err := x509.SystemCertPool()
		if err != nil {
			return nil, nil, errors.New("system trust store unavailable")
		}
		if !roots.AppendCertsFromPEM([]byte(input.CA)) {
			return nil, nil, errors.New("invalid additional CA")
		}
		transport.RootCAs = roots
	}
	options := []tlsclient.HttpClientOption{
		tlsclient.WithClientProfile(profiles.Firefox_148),
		tlsclient.WithTimeoutMilliseconds(input.TimeoutMS),
		tlsclient.WithNotFollowRedirects(),
		tlsclient.WithDisableHttp3(),
		tlsclient.WithTransportOptions(transport),
	}
	if input.Proxy != "" {
		proxy, err := url.Parse(input.Proxy)
		if err != nil || (proxy.Scheme != "http" && proxy.Scheme != "https") || proxy.Host == "" {
			return nil, nil, errors.New("invalid HTTP proxy")
		}
		options = append(options, tlsclient.WithProxyUrl(input.Proxy))
	}
	if input.Insecure {
		options = append(options, tlsclient.WithInsecureSkipVerify())
	}
	client, err := tlsclient.NewHttpClient(tlsclient.NewNoopLogger(), options...)
	if err != nil {
		return nil, nil, err
	}
	cleanup := client.CloseIdleConnections
	upstream, err := http.NewRequest(input.Method, input.URL, bytes.NewReader(input.Body))
	if err != nil {
		cleanup()
		return nil, nil, err
	}
	order := []string{}
	for _, header := range input.Headers {
		name := strings.ToLower(header[0])
		if name == http.HeaderOrderKey || name == http.PHeaderOrderKey {
			continue
		}
		if name == "host" {
			upstream.Host = header[1]
			continue
		}
		if _, exists := upstream.Header[name]; !exists {
			order = append(order, name)
		}
		upstream.Header[name] = append(upstream.Header[name], header[1])
	}
	if upstream.Header["user-agent"] == nil {
		upstream.Header["user-agent"] = []string{userAgent}
		order = append(order, "user-agent")
	}
	upstream.Header[http.HeaderOrderKey] = order
	execute := client.Do
	if target.Scheme == "http" && input.Proxy != "" {
		proxyURL, _ := url.Parse(input.Proxy)
		forward := &http.Transport{
			Proxy:                  http.ProxyURL(proxyURL),
			DisableCompression:     true,
			MaxResponseHeaderBytes: 65536,
			TLSClientConfig:        &tls.Config{RootCAs: transport.RootCAs, InsecureSkipVerify: input.Insecure},
		}
		forwardClient := &http.Client{
			Transport:     forward,
			Timeout:       time.Duration(input.TimeoutMS) * time.Millisecond,
			CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		}
		execute = forwardClient.Do
		cleanup = forward.CloseIdleConnections
	}
	result, err := execute(upstream)
	if err != nil {
		cleanup()
		return nil, nil, err
	}
	return result, cleanup, nil
}

func failure(err error, proxy bool) response {
	result := response{Version: protocolVersion, Error: "TLS helper request failed", Code: "TLS_FETCH_ERROR"}
	var unknown x509.UnknownAuthorityError
	var hostname x509.HostnameError
	var invalid x509.CertificateInvalidError
	var timeout net.Error
	switch {
	case errors.As(err, &unknown):
		result.Code, result.Error = certificateFailure(unknown.Cert, "UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "unable to get local issuer certificate")
	case errors.As(err, &hostname):
		result.Code, result.Error = certificateFailure(hostname.Certificate, "ERR_TLS_CERT_ALTNAME_INVALID", "hostname does not match certificate")
	case errors.As(err, &invalid):
		result.Code, result.Error = "CERT_UNTRUSTED", "certificate verification failed"
		if invalid.Reason == x509.Expired {
			result.Code, result.Error = "CERT_HAS_EXPIRED", "certificate has expired or is not yet valid"
		}
	case errors.As(err, &timeout) && timeout.Timeout():
		result.Code, result.Error = "ETIMEDOUT", "TLS helper request timed out"
	case proxy && strings.Contains(err.Error(), "407"):
		result.Code, result.Error = "PROXY_AUTH", "proxy authentication required (407)"
	case proxy:
		result.Code, result.Error = "PROXY_CONNECTION", "proxy connection failed"
	}
	return result
}

func certificateFailure(cert *x509.Certificate, code, message string) (string, string) {
	if cert != nil && bytes.Equal(cert.RawIssuer, cert.RawSubject) && cert.CheckSignature(cert.SignatureAlgorithm, cert.RawTBSCertificate, cert.Signature) == nil {
		return "DEPTH_ZERO_SELF_SIGNED_CERT", "self signed certificate"
	}
	return code, message
}

func run(input io.Reader, output io.Writer) int {
	var message request
	decoder := json.NewDecoder(io.LimitReader(input, 64<<20))
	encoder := json.NewEncoder(output)
	if err := decoder.Decode(&message); err != nil {
		_ = encoder.Encode(response{Version: protocolVersion, Error: "invalid helper request", Code: "PROTOCOL_ERROR"})
		return 1
	}
	result, cleanup, err := fetch(message)
	if err != nil {
		_ = encoder.Encode(failure(err, message.Proxy != ""))
		return 1
	}
	defer cleanup()
	defer result.Body.Close()
	if err := encoder.Encode(response{Version: protocolVersion, Status: result.StatusCode, Headers: result.Header}); err != nil {
		return 1
	}
	if _, err := io.Copy(output, result.Body); err != nil {
		return 1
	}
	return 0
}

func main() {
	if len(os.Args) == 2 && os.Args[1] == "--version" {
		_ = json.NewEncoder(os.Stdout).Encode(map[string]any{"version": protocolVersion, "profile": profileName, "userAgent": userAgent})
		return
	}
	os.Exit(run(os.Stdin, os.Stdout))
}
