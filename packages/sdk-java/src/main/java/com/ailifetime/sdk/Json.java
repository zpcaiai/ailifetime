package com.ailifetime.sdk;

import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

final class Json {
    private Json() {}

    static Map<String, Object> parseObject(String source) {
        Object value = new Parser(source).parse();
        if (!(value instanceof Map<?, ?> raw)) throw new IllegalArgumentException("JSON value must be an object");
        Map<String, Object> result = new LinkedHashMap<>();
        for (Map.Entry<?, ?> entry : raw.entrySet()) result.put((String) entry.getKey(), entry.getValue());
        return result;
    }

    static String stringify(Object value) {
        StringBuilder output = new StringBuilder();
        write(value, output);
        return output.toString();
    }

    private static void write(Object value, StringBuilder output) {
        if (value == null) {
            output.append("null");
        } else if (value instanceof String string) {
            writeString(string, output);
        } else if (value instanceof Boolean bool) {
            output.append(bool);
        } else if (value instanceof BigDecimal decimal) {
            output.append(decimal.toPlainString());
        } else if (value instanceof Number number) {
            output.append(number);
        } else if (value instanceof Map<?, ?> map) {
            output.append('{');
            boolean first = true;
            for (Map.Entry<?, ?> entry : map.entrySet()) {
                if (!(entry.getKey() instanceof String key)) throw new IllegalArgumentException("JSON object keys must be strings");
                if (!first) output.append(',');
                first = false;
                writeString(key, output);
                output.append(':');
                write(entry.getValue(), output);
            }
            output.append('}');
        } else if (value instanceof Iterable<?> values) {
            output.append('[');
            boolean first = true;
            for (Object item : values) {
                if (!first) output.append(',');
                first = false;
                write(item, output);
            }
            output.append(']');
        } else {
            throw new IllegalArgumentException("unsupported JSON value");
        }
    }

    private static void writeString(String value, StringBuilder output) {
        output.append('"');
        for (int index = 0; index < value.length(); index++) {
            char character = value.charAt(index);
            switch (character) {
                case '"' -> output.append("\\\"");
                case '\\' -> output.append("\\\\");
                case '\b' -> output.append("\\b");
                case '\f' -> output.append("\\f");
                case '\n' -> output.append("\\n");
                case '\r' -> output.append("\\r");
                case '\t' -> output.append("\\t");
                default -> {
                    if (character < 0x20) {
                        output.append("\\u");
                        String hex = Integer.toHexString(character);
                        output.append("0".repeat(4 - hex.length())).append(hex);
                    } else {
                        output.append(character);
                    }
                }
            }
        }
        output.append('"');
    }

    private static final class Parser {
        private final String source;
        private int index;

        private Parser(String source) {
            if (source == null) throw new IllegalArgumentException("JSON cannot be null");
            this.source = source;
        }

        private Object parse() {
            Object value = value(0);
            whitespace();
            if (index != source.length()) fail("unexpected trailing data");
            return value;
        }

        private Object value(int depth) {
            if (depth > 128) fail("JSON nesting limit exceeded");
            whitespace();
            if (index >= source.length()) fail("unexpected end of JSON");
            return switch (source.charAt(index)) {
                case '{' -> object(depth + 1);
                case '[' -> array(depth + 1);
                case '"' -> string();
                case 't' -> literal("true", Boolean.TRUE);
                case 'f' -> literal("false", Boolean.FALSE);
                case 'n' -> literal("null", null);
                default -> number();
            };
        }

        private Map<String, Object> object(int depth) {
            index++;
            LinkedHashMap<String, Object> result = new LinkedHashMap<>();
            whitespace();
            if (take('}')) return result;
            while (true) {
                whitespace();
                if (index >= source.length() || source.charAt(index) != '"') fail("object key must be a string");
                String key = string();
                if (result.containsKey(key)) fail("duplicate object key");
                whitespace();
                require(':');
                result.put(key, value(depth));
                whitespace();
                if (take('}')) return result;
                require(',');
            }
        }

        private List<Object> array(int depth) {
            index++;
            ArrayList<Object> result = new ArrayList<>();
            whitespace();
            if (take(']')) return result;
            while (true) {
                result.add(value(depth));
                whitespace();
                if (take(']')) return result;
                require(',');
            }
        }

        private String string() {
            require('"');
            StringBuilder result = new StringBuilder();
            while (index < source.length()) {
                char character = source.charAt(index++);
                if (character == '"') return result.toString();
                if (character < 0x20) fail("unescaped control character in string");
                if (character != '\\') {
                    result.append(character);
                    continue;
                }
                if (index >= source.length()) fail("unterminated escape");
                char escape = source.charAt(index++);
                switch (escape) {
                    case '"', '\\', '/' -> result.append(escape);
                    case 'b' -> result.append('\b');
                    case 'f' -> result.append('\f');
                    case 'n' -> result.append('\n');
                    case 'r' -> result.append('\r');
                    case 't' -> result.append('\t');
                    case 'u' -> result.append(unicodeEscape());
                    default -> fail("invalid string escape");
                }
            }
            fail("unterminated string");
            return "";
        }

        private char unicodeEscape() {
            if (index + 4 > source.length()) fail("incomplete unicode escape");
            int value = 0;
            for (int offset = 0; offset < 4; offset++) {
                int digit = Character.digit(source.charAt(index++), 16);
                if (digit < 0) fail("invalid unicode escape");
                value = (value << 4) | digit;
            }
            return (char) value;
        }

        private Object literal(String expected, Object value) {
            if (!source.startsWith(expected, index)) fail("invalid literal");
            index += expected.length();
            return value;
        }

        private BigDecimal number() {
            int start = index;
            take('-');
            if (take('0')) {
                if (index < source.length() && Character.isDigit(source.charAt(index))) fail("leading zero in number");
            } else {
                digits(true);
            }
            if (take('.')) digits(true);
            if (take('e') || take('E')) {
                if (!take('+')) take('-');
                digits(true);
            }
            try {
                return new BigDecimal(source.substring(start, index));
            } catch (NumberFormatException error) {
                throw new IllegalArgumentException("invalid JSON number at offset " + start, error);
            }
        }

        private void digits(boolean required) {
            int start = index;
            while (index < source.length() && Character.isDigit(source.charAt(index))) index++;
            if (required && start == index) fail("expected digit");
        }

        private void whitespace() {
            while (index < source.length()) {
                char character = source.charAt(index);
                if (character != ' ' && character != '\n' && character != '\r' && character != '\t') return;
                index++;
            }
        }

        private boolean take(char expected) {
            if (index < source.length() && source.charAt(index) == expected) {
                index++;
                return true;
            }
            return false;
        }

        private void require(char expected) {
            if (!take(expected)) fail("expected " + expected);
        }

        private void fail(String message) {
            throw new IllegalArgumentException(message + " at offset " + index);
        }
    }
}
