package sh.paseo.intellij;

import com.google.gson.JsonElement;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.google.gson.JsonPrimitive;
import java.io.Reader;
import java.net.URI;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.util.Locale;

/** Supplies the daemon's local credential only to the matching live desktop-managed daemon. */
public final class PaseoLocalCredentialBridge {
    private PaseoLocalCredentialBridge() {}

    public static JsonElement dispatch(JsonElement args) {
        if (args == null || !args.isJsonObject()) return JsonNull.INSTANCE;
        JsonElement listenValue = args.getAsJsonObject().get("listen");
        if (listenValue == null || !listenValue.isJsonPrimitive()) return JsonNull.INSTANCE;

        String token = readCredentialForTarget(resolvePaseoHome(), listenValue.getAsString());
        return token == null ? JsonNull.INSTANCE : new JsonPrimitive(token);
    }

    static String readCredentialForTarget(Path home, String target) {
        try (Reader reader = Files.newBufferedReader(home.resolve("paseo.pid"))) {
            JsonObject lock = JsonParser.parseReader(reader).getAsJsonObject();
            if (!lock.has("desktopManaged") || !lock.get("desktopManaged").getAsBoolean()) {
                return null;
            }
            if (!lock.has("pid") || !lock.get("pid").isJsonPrimitive()) return null;

            long pid = lock.get("pid").getAsLong();
            ProcessHandle process = ProcessHandle.of(pid).orElse(null);
            if (process == null || !process.isAlive() || !matchesStartTime(lock, process)) return null;

            String listen = primitiveString(lock.get("listen"));
            if (listen == null) return null;
            String selectedEndpoint = normalizeTcpEndpoint(target);
            String listeningEndpoint = normalizeTcpEndpoint(listen);
            if (selectedEndpoint == null || !selectedEndpoint.equals(listeningEndpoint)) return null;

            String token = Files.readString(home.resolve("local-credential")).trim();
            return token.matches("[A-Za-z0-9_-]{43}") ? token : null;
        } catch (Exception ignored) {
            return null;
        }
    }

    private static boolean matchesStartTime(JsonObject lock, ProcessHandle process) {
        if (!lock.has("startedAt") || !lock.get("startedAt").isJsonPrimitive()) return false;
        try {
            Instant lockStartedAt = Instant.parse(lock.get("startedAt").getAsString());
            Instant processStartedAt = process.info().startInstant().orElse(null);
            return processStartedAt == null ||
                Duration.between(processStartedAt, lockStartedAt).abs().compareTo(Duration.ofMinutes(2)) <= 0;
        } catch (RuntimeException ignored) {
            return false;
        }
    }

    private static String primitiveString(JsonElement value) {
        return value != null && value.isJsonPrimitive() && value.getAsJsonPrimitive().isString()
            ? value.getAsString()
            : null;
    }

    private static String normalizeTcpEndpoint(String input) {
        try {
            String value = input == null ? "" : input.trim();
            if (value.isEmpty()) return null;
            URI uri = new URI(value.contains("://") ? value : "tcp://" + value);
            if (!"tcp".equalsIgnoreCase(uri.getScheme()) || uri.getUserInfo() != null) return null;
            String host = uri.getHost();
            int port = uri.getPort();
            if (host == null || port < 1 || port > 65535) return null;

            boolean ipv6 = host.indexOf(':') >= 0;
            if (host.startsWith("[") && host.endsWith("]")) {
                host = host.substring(1, host.length() - 1);
                ipv6 = true;
            }
            host = host.toLowerCase(Locale.ROOT);
            if ((!ipv6 && (host.equals("127.0.0.1") || host.equals("0.0.0.0"))) ||
                (ipv6 && (host.equals("::1") || host.equals("::")))) {
                return "localhost:" + port;
            }
            return (ipv6 ? "[" + host + "]" : host) + ":" + port;
        } catch (Exception ignored) {
            return null;
        }
    }

    private static Path resolvePaseoHome() {
        String configured = System.getenv("PASEO_HOME");
        String value = configured == null || configured.isBlank() ? "~/.paseo" : configured.trim();
        if (value.equals("~")) return Path.of(System.getProperty("user.home"));
        if (value.startsWith("~/")) {
            return Path.of(System.getProperty("user.home")).resolve(value.substring(2)).normalize();
        }
        return Path.of(value).toAbsolutePath().normalize();
    }
}
