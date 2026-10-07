package main

import (
	"bytes"
	"compress/gzip"
	stdtls "crypto/tls"
	"encoding/json"
	"encoding/pem"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"

	"github.com/bogdanfinn/tls-client/profiles"
	tls "github.com/bogdanfinn/utls"
)

func TestFirefoxClientHello(t *testing.T) {
	hellos := make(chan *stdtls.ClientHelloInfo, 1)
	server := httptest.NewUnstartedServer(http.HandlerFunc(func(output http.ResponseWriter, input *http.Request) {
		output.WriteHeader(204)
	}))
	server.TLS = &stdtls.Config{GetConfigForClient: func(hello *stdtls.ClientHelloInfo) (*stdtls.Config, error) {
		hellos <- hello
		return nil, nil
	}}
	server.StartTLS()
	defer server.Close()
	result, cleanup, err := fetch(request{Version: 1, URL: server.URL, Method: "GET", Insecure: true, TimeoutMS: 2000})
	if err != nil {
		t.Fatal(err)
	}
	_ = result.Body.Close()
	cleanup()
	hello := <-hellos
	spec, err := profiles.Firefox_148.GetClientHelloSpec()
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(hello.CipherSuites, spec.CipherSuites) {
		t.Fatalf("wire cipher order differs from Firefox profile: %v", hello.CipherSuites)
	}
	for _, extension := range spec.Extensions {
		switch extension := extension.(type) {
		case *tls.ALPNExtension:
			if !reflect.DeepEqual(hello.SupportedProtos, extension.AlpnProtocols) {
				t.Fatal("ALPN mismatch")
			}
		case *tls.SupportedVersionsExtension:
			if !reflect.DeepEqual(hello.SupportedVersions, extension.Versions) {
				t.Fatal("TLS versions mismatch")
			}
		case *tls.SignatureAlgorithmsExtension:
			expected := make([]stdtls.SignatureScheme, len(extension.SupportedSignatureAlgorithms))
			for index, scheme := range extension.SupportedSignatureAlgorithms {
				expected[index] = stdtls.SignatureScheme(scheme)
			}
			if !reflect.DeepEqual(hello.SignatureSchemes, expected) {
				t.Fatal("signature algorithms mismatch")
			}
		}
	}
}

func TestRepeatedRequestHeadersAndBinaryBody(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(output http.ResponseWriter, input *http.Request) {
		if !reflect.DeepEqual(input.Header.Values("X-Repeated"), []string{"first", "second"}) {
			t.Error("repeated request headers changed", input.Header)
		}
		_, _ = io.Copy(output, input.Body)
	}))
	defer server.Close()
	input := request{
		Version: 1, URL: server.URL, Method: "POST", TimeoutMS: 2000,
		Headers: [][2]string{{"X-Repeated", "first"}, {"x-repeated", "second"}},
		Body:    []byte{0, 255, 1},
	}
	result, cleanup, err := fetch(input)
	if err != nil {
		t.Fatal(err)
	}
	defer cleanup()
	defer result.Body.Close()
	body, err := io.ReadAll(result.Body)
	if err != nil || !bytes.Equal(body, input.Body) {
		t.Fatal("binary body changed", body, err)
	}
}

func TestRawResponseAndRedirect(t *testing.T) {
	var compressed bytes.Buffer
	writer := gzip.NewWriter(&compressed)
	_, _ = writer.Write([]byte("hello"))
	_ = writer.Close()
	server := httptest.NewServer(http.HandlerFunc(func(output http.ResponseWriter, input *http.Request) {
		if input.URL.Path == "/redirect" {
			output.Header().Set("Location", "/body")
			output.WriteHeader(302)
			return
		}
		output.Header().Add("Set-Cookie", "first=1")
		output.Header().Add("Set-Cookie", "second=2")
		output.Header().Set("Content-Encoding", "gzip")
		_, _ = output.Write(compressed.Bytes())
	}))
	defer server.Close()
	for _, route := range []string{"/redirect", "/body"} {
		input, _ := json.Marshal(request{Version: 1, URL: server.URL + route, Method: "GET", TimeoutMS: 2000})
		var output bytes.Buffer
		if run(bytes.NewReader(input), &output) != 0 {
			t.Fatal(output.String())
		}
		line, err := output.ReadBytes('\n')
		if err != nil {
			t.Fatal(err)
		}
		var metadata response
		if err := json.Unmarshal(line, &metadata); err != nil {
			t.Fatal(err)
		}
		if route == "/redirect" {
			if metadata.Status != 302 {
				t.Fatal("redirect followed", metadata)
			}
		} else if !bytes.Equal(output.Bytes(), compressed.Bytes()) || len(metadata.Headers["Set-Cookie"]) != 2 {
			t.Fatal("representation or cookies changed", metadata)
		}
	}
}

func TestCertificatePolicyAndHTTP2(t *testing.T) {
	server := httptest.NewUnstartedServer(http.HandlerFunc(func(output http.ResponseWriter, input *http.Request) {
		output.Header().Set("X-Protocol", input.Proto)
		_, _ = io.Copy(output, input.Body)
	}))
	server.EnableHTTP2 = true
	server.StartTLS()
	defer server.Close()
	input := request{Version: 1, URL: server.URL, Method: "POST", Body: []byte{0, 255, 1}, TimeoutMS: 2000}
	_, _, err := fetch(input)
	if err == nil || failure(err, false).Code != "DEPTH_ZERO_SELF_SIGNED_CERT" {
		t.Fatal("untrusted certificate accepted or misclassified", err)
	}
	for _, insecure := range []bool{false, true} {
		input.Insecure = insecure
		if !insecure {
			input.CA = string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: server.Certificate().Raw}))
		} else {
			input.CA = ""
		}
		result, cleanup, err := fetch(input)
		if err != nil {
			t.Fatal(err)
		}
		body, err := io.ReadAll(result.Body)
		_ = result.Body.Close()
		cleanup()
		if err != nil || !bytes.Equal(body, input.Body) || result.Header.Get("X-Protocol") != "HTTP/2.0" {
			t.Fatal("TLS/HTTP2/body mismatch", err, result.Header)
		}
	}
}
