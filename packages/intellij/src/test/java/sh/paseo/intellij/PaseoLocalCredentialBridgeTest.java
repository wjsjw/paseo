package sh.paseo.intellij;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;

public final class PaseoLocalCredentialBridgeTest {
    private static final String TOKEN = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopq";

    private PaseoLocalCredentialBridgeTest() {}

    public static void main(String[] args) throws Exception {
        Path home = Files.createTempDirectory("paseo-intellij-credential-test-");
        try {
            writeCredential(home, TOKEN);
            writeLock(home, true, "127.0.0.1:6767", Instant.now().toString());
            check(TOKEN.equals(read(home, "tcp://localhost:6767")), "matching live managed daemon");
            check(read(home, "localhost:6768") == null, "wrong endpoint");

            writeLock(home, false, "127.0.0.1:6767", Instant.now().toString());
            check(read(home, "localhost:6767") == null, "non-managed daemon");

            writeLock(home, true, "127.0.0.1:6767", Instant.now().toString());
            writeCredential(home, "not-a-valid-local-credential");
            check(read(home, "localhost:6767") == null, "malformed credential");

            writeCredential(home, TOKEN);
            writeLock(home, true, "127.0.0.1:6767", "not-an-instant");
            check(read(home, "localhost:6767") == null, "malformed process start time");
        } finally {
            try (var paths = Files.walk(home)) {
                paths.sorted((left, right) -> right.compareTo(left)).forEach(path -> {
                    try {
                        Files.deleteIfExists(path);
                    } catch (Exception error) {
                        throw new RuntimeException(error);
                    }
                });
            }
        }
        System.out.println("PaseoLocalCredentialBridgeTest passed.");
        if (args.length == 2) {
            check(read(Path.of(args[0]), args[1]) != null, "live desktop-managed daemon credential");
            System.out.println("Live credential lookup passed (token redacted).");
        } else if (args.length != 0) {
            throw new IllegalArgumentException("Pass either no arguments or <paseo-home> <listen>.");
        }
    }

    private static String read(Path home, String listen) {
        return PaseoLocalCredentialBridge.readCredentialForTarget(home, listen);
    }

    private static void writeCredential(Path home, String token) throws Exception {
        Files.writeString(home.resolve("local-credential"), token + "\n");
    }

    private static void writeLock(Path home, boolean desktopManaged, String listen, String startedAt)
        throws Exception {
        JsonObject lock = new JsonObject();
        lock.addProperty("pid", ProcessHandle.current().pid());
        lock.addProperty("desktopManaged", desktopManaged);
        lock.addProperty("listen", listen);
        lock.addProperty("startedAt", startedAt);
        Files.writeString(home.resolve("paseo.pid"), JsonParser.parseString(lock.toString()).toString());
    }

    private static void check(boolean condition, String description) {
        if (!condition) throw new AssertionError("Failed: " + description);
    }
}
